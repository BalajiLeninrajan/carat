import { describe, expect, it, vi } from 'vitest';
import type { ImageInput, SuggestRequest } from '@carat/shared';
import { OpenAICompatProvider, type OutputMode, type ReasoningEffort } from '../src/openai-compat';

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

function provider(fetchImpl: typeof fetch, mode: OutputMode = 'json_schema', reasoningEffort?: ReasoningEffort) {
  return new OpenAICompatProvider(
    { id: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-5-mini', mode, ...(reasoningEffort ? { reasoningEffort } : {}) },
    fetchImpl,
  );
}

function requestBody(call: unknown[]): { messages: Array<{ role: string; content: string }>; response_format?: unknown; reasoning_effort?: string } {
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

  it('keeps an interaction on a described element with a fitting verb, and drops the rest', async () => {
    const calendar: SuggestRequest = {
      page: { host: 'calendar.google.com', title: 'Calendar', path: '/calendar/u/0/r/eventedit' },
      fields: [],
      elements: [
        { i: 'e0', r: 'button', nm: 'Save', p: 1 },
        { i: 'e1', r: 'checkbox', nm: 'All day', st: 'on' },
        { i: 'e2', r: 'slider', nm: 'Volume', v: '80', min: 0, max: 100 },
        { i: 'e3', r: 'button', nm: 'Delete event' },
      ],
      filled: ['c1'],
      context: [{ id: 'c1', origin: 'https://discord.com', title: 'Discord', kind: 'page', text: 'dinner at Seven Shores Cafe, Friday at 6?', capturedAt: 1 }],
      now: '2026-09-16T14:04:00-04:00',
    };
    const click = { kind: 'interact', fieldId: '', value: 'Save', confidence: 0.85, reason: 'commits the fills', sourceContextId: 'c1', intent: '', when: '', location: '', elementId: 'e0', verb: 'click' };
    const fetchImpl = vi.fn(async () =>
      completion(
        JSON.stringify({
          suggestions: [
            click,
            { ...click, elementId: 'e1', verb: 'check', value: 'All day' }, // already on
            { ...click, elementId: 'e1', verb: 'uncheck', value: 'All day', confidence: 0.6 }, // too weak
            { ...click, elementId: 'e2', verb: 'set', value: '140' }, // out of range
            { ...click, elementId: 'e2', verb: 'set', value: '40', sourceContextId: 'o9' }, // unknown source
            { ...click, elementId: 'e3', verb: 'click', value: 'Delete event' }, // destructive
            { ...click, elementId: 'e9', verb: 'click', value: 'Ghost' }, // not described
            { ...click, elementId: 'e0', verb: 'click', value: 'Save', confidence: 0.8 }, // duplicate, lower
          ],
        }),
      ),
    );
    const out = await provider(fetchImpl).suggest(calendar, { signal: new AbortController().signal });
    expect(out).toEqual([
      { kind: 'interact', elementId: 'e0', verb: 'click', value: 'Save', confidence: 0.85, reason: 'commits the fills', sourceContextId: 'c1' },
    ]);

    // Without a fill behind it, a button click is not the model's to propose.
    const { filled: _f, ...unfilled } = calendar;
    expect(await provider(fetchImpl).suggest(unfilled, { signal: new AbortController().signal })).toEqual([]);
  });

  it('never turns text from the page itself into a fill', async () => {
    const fetchImpl = vi.fn(async () => completion(JSON.stringify({ suggestions: [{ ...good, sourceContextId: 'o7' }] })));
    expect(await provider(fetchImpl).suggest(discord, { signal: new AbortController().signal })).toEqual([]);
  });

  it('keeps suggest text-only: every message content is a string', async () => {
    const fetchImpl = vi.fn(async () => completion(JSON.stringify({ suggestions: [good] })));
    await provider(fetchImpl).suggest(req, { signal: new AbortController().signal });
    for (const m of requestBody(fetchImpl.mock.calls[0]!).messages) expect(typeof m.content).toBe('string');
  });

  it('sends reasoning_effort on suggest and transcribe only when the option is set', async () => {
    const fast = vi.fn(async () => completion(JSON.stringify({ suggestions: [good] })));
    await provider(fast, 'json_schema', 'none').suggest(req, { signal: new AbortController().signal });
    expect(requestBody(fast.mock.calls[0]!).reasoning_effort).toBe('none');

    const smart = vi.fn(async () => completion(JSON.stringify({ suggestions: [good] })));
    const smartProvider = provider(smart, 'json_schema', 'low');
    await smartProvider.suggest(req, { signal: new AbortController().signal });
    await smartProvider.transcribe(image, { signal: new AbortController().signal });
    expect(requestBody(smart.mock.calls[0]!).reasoning_effort).toBe('low');
    expect(requestBody(smart.mock.calls[1]!).reasoning_effort).toBe('low');

    const plain = vi.fn(async () => completion(JSON.stringify({ suggestions: [good] })));
    await provider(plain, 'json_object').suggest(req, { signal: new AbortController().signal });
    await provider(plain, 'json_object').transcribe(image, { signal: new AbortController().signal });
    expect(requestBody(plain.mock.calls[0]!)).not.toHaveProperty('reasoning_effort');
    expect(requestBody(plain.mock.calls[1]!)).not.toHaveProperty('reasoning_effort');
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

const image: ImageInput = { dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', title: 'Discord | #general', host: 'discord.com', now: '2026-09-16T14:04:00-04:00', cue: 'thin-text' };

// What the smart model is asked to write for an Instagram post seen three days after it went up.
const INSTAGRAM_POST = {
  image: { dataUrl: 'data:image/jpeg;base64,/9j/4BBQ', title: 'Instagram', host: 'www.instagram.com', now: '2026-09-19T10:30:00-04:00', cue: 'image-heavy' } satisfies ImageInput,
  reply: [
    'sevenshorescafe',
    'Night market pop-up this Saturday 6 to 11pm, 10 Regina St N. $8 plates.',
    '3 days ago',
    '',
    'Facts:',
    'Posted 2026-09-16',
    'Event 2026-09-26T18:00:00-04:00 to 2026-09-26T23:00:00-04:00',
    'Venue: Seven Shores Cafe',
    'Address: 10 Regina St N',
    'Handle: @sevenshorescafe',
    'Price: $8 per plate',
    'Poster: Night Market, Sat 6pm, Seven Shores Cafe',
  ].join('\n'),
};

describe('OpenAICompatProvider.transcribe', () => {
  it('sends the screenshot as an image_url data URI part on the configured model and returns plain text', async () => {
    const fetchImpl = vi.fn(async () => completion('alex: dinner at\n\nSeven Shores Cafe,   Friday at 6?'));
    const out = await provider(fetchImpl).transcribe(image, { signal: new AbortController().signal });

    expect(out).toBe('alex: dinner at Seven Shores Cafe, Friday at 6?');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-5-mini');
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0]).toEqual({ role: 'system', content: expect.stringContaining('Facts:') });
    const parts = body.messages[1].content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: expect.stringContaining('discord.com') });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'low' } });
  });

  it('hands the model the capture time with the image, and keeps the Facts block it writes back', async () => {
    const fetchImpl = vi.fn(async () => completion(INSTAGRAM_POST.reply));
    const out = await provider(fetchImpl).transcribe(INSTAGRAM_POST.image, { signal: new AbortController().signal });

    const parts = requestBody(fetchImpl.mock.calls[0]!).messages[1]!.content as unknown as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: expect.stringContaining('now: 2026-09-19T10:30:00-04:00') });
    expect(parts[0]!.text).toContain('www.instagram.com');
    expect(parts[0]!.text).toContain('"Instagram"');
    // The post was cued by its picture, not by thin text, so the model gets the full rendering.
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: INSTAGRAM_POST.image.dataUrl, detail: 'high' } });

    // One line, page-item sized, with the resolved facts still in it: this is what the context store gets.
    expect(out).toContain('3 days ago Facts: Posted 2026-09-16 Event 2026-09-26T18:00:00-04:00');
    expect(out).toContain('Poster: Night Market, Sat 6pm, Seven Shores Cafe');
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  it('asks for the small rendering of a thin-text page and the full one of an image-heavy page', async () => {
    const detail = async (cue: ImageInput['cue']) => {
      const fetchImpl = vi.fn(async () => completion('some text'));
      await provider(fetchImpl).transcribe({ ...image, cue }, { signal: new AbortController().signal });
      const parts = requestBody(fetchImpl.mock.calls[0]!).messages[1]!.content as unknown as Array<{ image_url?: { detail: string } }>;
      return parts[1]!.image_url!.detail;
    };
    expect(await detail('thin-text')).toBe('low');
    expect(await detail('image-heavy')).toBe('high');
  });

  it('clips the transcript to a page item length', async () => {
    const fetchImpl = vi.fn(async () => completion('x'.repeat(5000)));
    const out = await provider(fetchImpl).transcribe(image, { signal: new AbortController().signal });
    expect(out.length).toBe(4000);
  });

  it("returns '' for an empty or missing reply and for an abort, and rejects on HTTP errors", async () => {
    expect(await provider(vi.fn(async () => completion('   '))).transcribe(image, { signal: new AbortController().signal })).toBe('');
    expect(await provider(vi.fn(async () => completion(null))).transcribe(image, { signal: new AbortController().signal })).toBe('');

    const never = vi.fn();
    expect(await provider(never as unknown as typeof fetch).transcribe(image, { signal: AbortSignal.abort() })).toBe('');
    expect(never).not.toHaveBeenCalled();

    const controller = new AbortController();
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = provider(hang as unknown as typeof fetch).transcribe(image, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBe('');

    await expect(provider(vi.fn(async () => completion(null, 429))).transcribe(image, { signal: new AbortController().signal })).rejects.toThrow(
      'HTTP 429',
    );
  });
});
