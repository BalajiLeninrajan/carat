import { describe, expect, it, vi } from 'vitest';
import type { NextActionRequest } from '@carat/shared';
import { OpenAICompatProvider, cacheKey, memoryRelaxStore } from '../src/openai-compat';

const req: NextActionRequest = {
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps', scroll: { y: 0, pages: 1, more: false } },
  outline: '>> FOCUSED [1] searchbox "Search Google Maps"',
  controls: [{ n: 1, role: 'searchbox', name: 'Search Google Maps' }],
  focused: 1,
  history: [],
  notes: ['Dinner at Seven Shores Cafe on Friday at 6.'],
  tabs: [],
  now: '2026-09-16T14:04:00-04:00',
  eagerness: 'eager',
};

function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = new TextEncoder();
      for (const piece of chunks) {
        controller.enqueue(encode.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
      }
      controller.enqueue(encode.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const provider = (fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof OpenAICompatProvider>[0]> = {}) =>
  new OpenAICompatProvider(
    {
      id: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'k',
      model: 'gpt-5.6-luna',
      mode: 'json_schema',
      reasoningEffort: 'none',
      ...over,
    },
    fetchImpl,
  );

describe('the streamed action call', () => {
  it('announces the target before the label has arrived, and returns the whole action', async () => {
    const order: string[] = [];
    const chunks = ['{"target":', '1,"kind":"fill",', '"value":"Seven Shores Cafe",', '"label":"Fill Search with \\"Seven Shores Cafe\\"",', '"irreversible":false,"confidence":0.9,"reason":"the note names it"}'];
    const fetchImpl = vi.fn(async () => sse(chunks)) as unknown as typeof fetch;
    const p = provider(fetchImpl);
    const action = await p.next(req, {
      signal: new AbortController().signal,
      onPartial: ({ target }) => order.push(`partial:${target}`),
    });
    order.push('done');
    expect(order).toEqual(['partial:1', 'done']);
    expect(action).toMatchObject({ kind: 'fill', target: 1, value: 'Seven Shores Cafe', confidence: 0.9 });
  });

  it('salvages a body the output limit cut off', async () => {
    const fetchImpl = vi.fn(async () => sse(['{"target":2,"kind":"fill","value":"Thanks for confirming. Since all three are on 3.2'])) as unknown as typeof fetch;
    const action = await provider(fetchImpl).next(req, { signal: new AbortController().signal });
    expect(action).toMatchObject({ kind: 'fill', target: 2, value: 'Thanks for confirming.' });
  });

  it('sends a cache key for the page, the strict schema and no reasoning', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return sse(['{"target":null,"kind":"none","value":"","label":"","irreversible":false,"confidence":0,"reason":""}']);
    }) as unknown as typeof fetch;
    await provider(fetchImpl).next(req, { signal: new AbortController().signal });
    expect(body.prompt_cache_key).toBe(cacheKey('www.google.com', '/maps'));
    expect(body.reasoning_effort).toBe('none');
    expect(body.stream).toBe(true);
    expect((body.response_format as { type: string }).type).toBe('json_schema');
  });

  it('drops a parameter the server names in a 400, retries, and remembers it for that model', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if ('reasoning_effort' in body) {
        return new Response(JSON.stringify({ error: { message: 'unsupported', param: 'reasoning_effort' } }), { status: 400 });
      }
      return sse(['{"target":1,"kind":"click","value":"","label":"Go","irreversible":false,"confidence":0.6,"reason":"x"}']);
    }) as unknown as typeof fetch;
    const relax = memoryRelaxStore();
    const p = provider(fetchImpl, { relaxStore: relax });
    expect(await p.next(req, { signal: new AbortController().signal })).toMatchObject({ kind: 'click' });
    expect(bodies).toHaveLength(2);
    expect(await relax.dropped('gpt-5.6-luna')).toEqual(['reasoning_effort']);

    await p.next(req, { signal: new AbortController().signal });
    expect(bodies).toHaveLength(3);
    expect('reasoning_effort' in bodies[2]!).toBe(false);
  });

  it('never drops the model or the messages, whatever the server says', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'no', param: 'messages' } }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(provider(fetchImpl).next(req, { signal: new AbortController().signal })).rejects.toThrow('HTTP 400');
  });

  it('rejects on a transport failure and answers nothing on an abort', async () => {
    const boom = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(provider(boom).next(req, { signal: new AbortController().signal })).rejects.toThrow('offline');
    expect(await provider(boom).next(req, { signal: AbortSignal.abort() })).toBeNull();
  });
});

describe('distill', () => {
  it('returns at most five trimmed facts and never throws', async () => {
    const notes = { notes: ['  one ', 'two', 'three', 'four', 'five', 'six', ''] };
    const ok = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(notes) } }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const facts = await provider(ok).distill('a'.repeat(80), 'discord.com', new AbortController().signal);
    expect(facts).toEqual(['one', 'two', 'three', 'four', 'five']);

    const broken = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await provider(broken).distill('a'.repeat(80), 'discord.com', new AbortController().signal)).toEqual([]);
  });

  it('skips a page with almost nothing on it', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await provider(fetchImpl).distill('short', 'discord.com', new AbortController().signal)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
