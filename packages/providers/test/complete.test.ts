import { describe, expect, it, vi } from 'vitest';
import { GHOST_INSTRUCTIONS } from '@carat/shared';
import { OpenAICompatProvider } from '../src/openai-compat';
import type { CompleteRequest } from '../src/provider';

const req: CompleteRequest = {
  prefix: 'Dinner at Seven',
  outline: 'main:\n  [1] textbox "Message"',
  notes: ['Dinner at Seven Shores Cafe on Friday at 6.'],
  singleLine: true,
  maxTokens: 24,
  page: { host: 'discord.com', path: '/channels/1/2' },
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

const provider = (fetchImpl: typeof fetch) =>
  new OpenAICompatProvider(
    { id: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-5.6-luna', mode: 'json_schema', reasoningEffort: 'none' },
    fetchImpl,
  );

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;

describe('the ghost completion', () => {
  it('streams, asks for no reasoning and no JSON mode, and caps at the field kind', async () => {
    const fetchImpl = vi.fn(async () => sse([' Shores Cafe'])) as unknown as typeof fetch;
    await provider(fetchImpl).complete(req, { signal: new AbortController().signal });
    const body = bodyOf(fetchImpl as unknown as ReturnType<typeof vi.fn>);
    expect(body.stream).toBe(true);
    expect(body.reasoning_effort).toBe('none');
    expect(body.response_format).toBeUndefined();
    expect(body.max_completion_tokens).toBe(24);
    expect(body.prompt_cache_key).toEqual(expect.any(String));
    expect((body.messages as Array<{ content: string }>)[0]!.content).toBe(GHOST_INSTRUCTIONS);
  });

  it('hands the first token over before the last one arrives', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () => sse([' Shores', ' Cafe', ' on Friday'])) as unknown as typeof fetch;
    const text = await provider(fetchImpl).complete(req, {
      signal: new AbortController().signal,
      onDelta: (soFar) => seen.push(soFar),
    });
    expect(seen[0]).toBe(' Shores');
    expect(seen).toEqual([' Shores', ' Shores Cafe', ' Shores Cafe on Friday']);
    expect(text).toBe(' Shores Cafe on Friday');
  });

  it('cleans as it streams, so a quote the model opened with is never drawn', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () => sse(['"Shores', ' Cafe"'])) as unknown as typeof fetch;
    const text = await provider(fetchImpl).complete(req, {
      signal: new AbortController().signal,
      onDelta: (soFar) => seen.push(soFar),
    });
    expect(seen).toEqual(['Shores', 'Shores Cafe']);
    expect(text).toBe('Shores Cafe');
  });

  it('cuts a one-line answer at the newline and leaves a multi-line one whole', async () => {
    const fetchImpl = vi.fn(async () => sse([' Shores Cafe\nsee you there'])) as unknown as typeof fetch;
    expect(await provider(fetchImpl).complete(req, { signal: new AbortController().signal })).toBe(' Shores Cafe');
    const other = vi.fn(async () => sse([' Shores Cafe\nsee you there'])) as unknown as typeof fetch;
    expect(await provider(other).complete({ ...req, singleLine: false, maxTokens: 48 }, { signal: new AbortController().signal })).toBe(
      ' Shores Cafe\nsee you there',
    );
  });

  it('answers with nothing when the model fails, rather than rejecting', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await provider(fetchImpl).complete(req, { signal: new AbortController().signal })).toBe('');
  });

  it('answers with nothing on an abort', async () => {
    const abort = new AbortController();
    abort.abort();
    const fetchImpl = vi.fn(async () => sse([' Shores'])) as unknown as typeof fetch;
    expect(await provider(fetchImpl).complete(req, { signal: abort.signal })).toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('leaves the cache key out when the caller did not name a page', async () => {
    const fetchImpl = vi.fn(async () => sse([' x'])) as unknown as typeof fetch;
    const { page: _page, ...noPage } = req;
    await provider(fetchImpl).complete(noPage, { signal: new AbortController().signal });
    expect(bodyOf(fetchImpl as unknown as ReturnType<typeof vi.fn>).prompt_cache_key).toBeUndefined();
  });
});
