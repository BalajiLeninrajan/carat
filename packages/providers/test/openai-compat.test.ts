import { describe, expect, it, vi } from 'vitest';
import type { SuggestRequest } from '@carat/shared';
import { OpenAICompatProvider, type OutputMode } from '../src/openai-compat';

const req: SuggestRequest = {
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' },
  fields: [
    { i: 'f0', t: 'input:text', al: 'Search Google Maps', f: 1, w: 'l' },
    { i: 'f1', t: 'input:text', al: 'Filled already', v: 'typed' },
  ],
  context: [
    { id: 'c1', origin: 'https://discord.com', title: 'Discord', kind: 'page', text: 'dinner at Seven Shores Cafe, Friday at 6?', capturedAt: 1 },
  ],
  now: '2026-09-16T14:04:00-04:00',
};

const good = { kind: 'fill' as const, fieldId: 'f0', value: 'Seven Shores Cafe', confidence: 0.92, reason: 'place', sourceContextId: 'c1' };

const discord: SuggestRequest = {
  page: { host: 'discord.com', title: 'Discord', path: '/channels/1/2' },
  fields: [{ i: 'f0', t: 'textbox', al: 'Message #general', f: 1 }],
  context: [],
  own: [{ id: 'o7', origin: 'https://discord.com', title: 'Discord', kind: 'page', text: 'dinner at Seven Shores Cafe, Friday at 6?', capturedAt: 1 }],
  now: '2026-09-16T14:04:00-04:00',
};
const action = {
  kind: 'action',
  fieldId: '',
  value: 'Seven Shores Cafe',
  confidence: 0.9,
  reason: 'place to look up',
  sourceContextId: 'o7',
  intent: 'maps',
  when: '',
  location: '',
};

function completion(content: string | null, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider(fetchImpl: typeof fetch, mode: OutputMode = 'json_schema') {
  return new OpenAICompatProvider(
    { id: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-5-mini', mode },
    fetchImpl,
  );
}

function requestBody(call: unknown[]): { messages: Array<{ role: string; content: string }>; response_format?: unknown } {
  return JSON.parse((call[1] as RequestInit).body as string);
}

function lastUserMessage(call: unknown[]): string {
  return requestBody(call).messages.at(-1)!.content;
}

describe('OpenAICompatProvider', () => {
  it('posts to chat/completions with the strict schema and returns validated suggestions', async () => {
    const fetchImpl = vi.fn(async () => completion(JSON.stringify({ suggestions: [good] })));
    const out = await provider(fetchImpl).suggest(req, { signal: new AbortController().signal });

    expect(out).toEqual([good]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-5-mini');
    expect(body.messages[0].role).toBe('system');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(JSON.parse(lastUserMessage(fetchImpl.mock.calls[0]!)).page.host).toBe('www.google.com');
  });

  it('retries once with the parse error appended when the first reply is malformed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(completion('Sure! Here is the JSON: {oops'))
      .mockResolvedValueOnce(completion(JSON.stringify({ suggestions: [good] })));
    const out = await provider(fetchImpl as unknown as typeof fetch).suggest(req, { signal: new AbortController().signal });

    expect(out).toEqual([good]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retry = lastUserMessage(fetchImpl.mock.calls[1]!);
    expect(retry.startsWith(lastUserMessage(fetchImpl.mock.calls[0]!))).toBe(true);
    expect(retry).toContain('rejected: invalid JSON');
  });

  it('retries on a schema mismatch and reports the failing path', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(completion(JSON.stringify({ suggestions: [{ fieldId: 'f0', value: 'x' }] })))
      .mockResolvedValueOnce(completion(JSON.stringify({ suggestions: [good] })));
    await provider(fetchImpl as unknown as typeof fetch).suggest(req, { signal: new AbortController().signal });
    expect(lastUserMessage(fetchImpl.mock.calls[1]!)).toContain('suggestions.0.confidence');
  });

  it('returns [] after two unparseable replies', async () => {
    const fetchImpl = vi.fn(async () => completion('nope'));
    const out = await provider(fetchImpl).suggest(req, { signal: new AbortController().signal });
    expect(out).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('drops suggestions under 0.7, for unknown fields, and for fields with a value', async () => {
    const fetchImpl = vi.fn(async () =>
      completion(
        JSON.stringify({
          suggestions: [
            { ...good, confidence: 0.69 },
            { ...good, fieldId: 'f9', confidence: 0.99 },
            { ...good, fieldId: 'f1', confidence: 0.99 },
            { ...good, confidence: 0.7, value: ' Seven Shores Cafe ' },
          ],
        }),
      ),
    );
    const out = await provider(fetchImpl).suggest(req, { signal: new AbortController().signal });
    expect(out).toEqual([{ ...good, confidence: 0.7 }]);
  });

  it('drops suggestions whose source is not one of the request context items or is the page itself', async () => {
    const withSelf: SuggestRequest = {
      ...req,
      context: [...req.context, { id: 'c9', origin: 'https://www.google.com', title: 'Maps', kind: 'page', text: 'Seven Shores Cafe', capturedAt: 2 }],
    };
    const fetchImpl = vi.fn(async () =>
      completion(
        JSON.stringify({
          suggestions: [
            { ...good, sourceContextId: 'c2' }, // few-shot id echoed
            { ...good, sourceContextId: 'c9' }, // same site as the page
          ],
        }),
      ),
    );
    expect(await provider(fetchImpl).suggest(withSelf, { signal: new AbortController().signal })).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns [] instead of throwing when the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = provider(fetchImpl as unknown as typeof fetch).suggest(req, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not call fetch at all on an already-aborted signal', async () => {
    const fetchImpl = vi.fn();
    const out = await provider(fetchImpl as unknown as typeof fetch).suggest(req, { signal: AbortSignal.abort() });
    expect(out).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects on HTTP errors and network failures without retrying', async () => {
    const http = vi.fn(async () => completion(null, 500));
    await expect(provider(http).suggest(req, { signal: new AbortController().signal })).rejects.toThrow('HTTP 500');
    expect(http).toHaveBeenCalledTimes(1);

    const network = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(provider(network as unknown as typeof fetch).suggest(req, { signal: new AbortController().signal })).rejects.toThrow(
      'fetch failed',
    );
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('never calls fetch as a method of the provider (Chrome throws Illegal invocation otherwise)', async () => {
    // Chrome's fetch is a WebIDL operation on the global: `this` must be
    // undefined or the global itself. Node does not check, so emulate it.
    const strict = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch': Illegal invocation");
      return Promise.resolve(completion(JSON.stringify({ suggestions: [good] })));
    } as unknown as typeof fetch;

    expect(await provider(strict).suggest(req, { signal: new AbortController().signal })).toEqual([good]);
  });

  it('keeps an action sourced from the page itself and drops one sourced from another tab or aimed at the current page', async () => {
    const fetchImpl = vi.fn(async () =>
      completion(
        JSON.stringify({
          suggestions: [
            action,
            { ...action, intent: 'calendar', value: 'Dinner at Seven Shores Cafe', when: '2026-09-18T18:00:00-04:00', location: 'Seven Shores Cafe', sourceContextId: 'c1' },
            { ...action, intent: 'gmail', value: 'x@y.co', confidence: 0.5 },
          ],
        }),
      ),
    );
    const out = await provider(fetchImpl).suggest(discord, { signal: new AbortController().signal });
    expect(out).toEqual([
      { kind: 'action', intent: 'maps', value: 'Seven Shores Cafe', when: '', location: '', confidence: 0.9, reason: 'place to look up', sourceContextId: 'o7' },
    ]);

    const onMaps: SuggestRequest = { ...discord, page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' } };
    expect(await provider(fetchImpl).suggest(onMaps, { signal: new AbortController().signal })).toEqual([]);
  });

  it('never turns text from the page itself into a fill', async () => {
    const fetchImpl = vi.fn(async () => completion(JSON.stringify({ suggestions: [{ ...good, sourceContextId: 'o7' }] })));
    expect(await provider(fetchImpl).suggest(discord, { signal: new AbortController().signal })).toEqual([]);
  });

  it('uses json_object for baseten-style servers and no response_format in prompt mode, tolerating fences', async () => {
    const fenced = '```json\n' + JSON.stringify([good]) + '\n```';
    const fetchImpl = vi.fn(async () => completion(fenced));

    expect(await provider(fetchImpl, 'json_object').suggest(req, { signal: new AbortController().signal })).toEqual([good]);
    expect(requestBody(fetchImpl.mock.calls[0]!).response_format).toEqual({ type: 'json_object' });

    expect(await provider(fetchImpl, 'prompt').suggest(req, { signal: new AbortController().signal })).toEqual([good]);
    expect(requestBody(fetchImpl.mock.calls[1]!).response_format).toBeUndefined();
  });
});
