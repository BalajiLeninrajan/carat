import { describe, expect, it, vi } from 'vitest';
import type { FillSuggestion, SuggestRequest, Suggestion } from '@carat/shared';
import { JevProvider, GATE_MIN } from '../src/jev';
import { buildJevRequest } from '../src/jev/request';

const signal = () => new AbortController().signal;
const fills = (out: Suggestion[]): FillSuggestion[] => out.filter((s): s is FillSuggestion => s.kind === 'fill');

const discord = {
  id: 'c1',
  origin: 'https://discord.com',
  title: 'Discord | #general | Waterloo Friends',
  kind: 'page' as const,
  text: 'alex: dinner at Seven Shores Cafe, Friday at 6? sam: sounds good, see you there',
  capturedAt: 1758046800000,
};
const maps = {
  id: 'c2',
  origin: 'https://www.google.com',
  title: 'Seven Shores Cafe - Google Maps',
  kind: 'page' as const,
  text: 'Seven Shores Cafe 4.6 (312) Cafe 10 Regina St N, Waterloo, ON N2J 2Z8 Open Closes 9 p.m. (519) 555-0142',
  capturedAt: 1758046920000,
};

const calendar: SuggestRequest = {
  page: { host: 'calendar.google.com', title: 'Google Calendar', path: '/calendar/u/0/r/eventedit' },
  fields: [
    { i: 'f0', t: 'input:text', al: 'Add title', ph: 'Add title', w: 'l' },
    { i: 'f1', t: 'input:text', al: 'Add location', ph: 'Add location', f: 1, w: 'm' },
    { i: 'f2', t: 'ce', al: 'Description', w: 'l' },
    { i: 'f3', t: 'input:text', al: 'Filled already', v: 'typed' },
    { i: 'f4', t: 'input:text', lb: 'Username', ac: 'username' },
  ],
  context: [maps, discord],
  now: '2026-09-16T14:06:00-04:00',
  locale: 'en-CA',
};

type Answers = Record<string, unknown>;

const noul = (p: number) => ({ type: 'noul', noul: p });
function pick(choice: string, p: number, keys: string[]) {
  const rest = keys.filter((k) => k !== choice);
  const probabilities: Record<string, number> = { [choice]: p };
  for (const k of rest) probabilities[k] = (1 - p) / rest.length;
  return { type: 'choice', choice, confidence: p, probabilities };
}

function envelope(answers: Answers, status = 200): Response {
  return new Response(
    JSON.stringify({ result: { model: 'jev-1.13.0', answers, usage: { input_tokens: 500, output_tokens: 40 } }, success: true, errors: [], messages: [] }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function provider(fetchImpl: typeof fetch) {
  return new JevProvider({ accountId: 'acct-1', apiToken: 'cf-token' }, fetchImpl);
}

function sent(fetchImpl: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as { model: string; input: { state: Record<string, unknown>; questions: Record<string, { type: string; criteria: Record<string, unknown> }> } } };
}

// Keys the provider assigns, so tests can answer with the same ones.
const built = buildJevRequest(calendar, calendar.context)!;
const keys = [...built.options.map((o) => o.key), 'none'];
const keyOf = (value: string) => built.options.find((o) => o.candidate.value === value)!.key;

describe('buildJevRequest', () => {
  it('lists candidates with their source and asks one gate plus one choice per fillable field', () => {
    expect(built.state.page).toEqual(calendar.page);
    expect(built.state.candidates).toEqual([
      { id: 'k0', kind: 'phone number', value: '(519) 555-0142', from: 'c2' },
      { id: 'k1', kind: 'street address', value: '10 Regina St N, Waterloo, ON N2J 2Z8', from: 'c2' },
      { id: 'k2', kind: 'place name', value: 'Seven Shores Cafe', from: 'c2' },
      { id: 'k3', kind: 'plan (activity at a place)', value: 'Dinner at Seven Shores Cafe', from: 'c1' },
    ]);
    expect(Object.keys(built.questions)).toEqual(['relevant', 'field_f0', 'field_f1', 'field_f2']);
    expect(built.questions.relevant!.type).toBe('noul');
    expect(built.questions.relevant!.criteria).toHaveProperty('true');
    const q = built.questions.field_f1!;
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria as object)).toEqual(['k0', 'k1', 'k2', 'k3', 'none']);
    expect((q.criteria as Record<string, unknown>).k1).toEqual({
      value: '10 Regina St N, Waterloo, ON N2J 2Z8',
      kind: 'street address',
      source: 'Seven Shores Cafe - Google Maps (www.google.com)',
    });
  });

  it('is null when there is no candidate or no fillable field', () => {
    const plain = { ...discord, text: 'ok so who is around this weekend' };
    expect(buildJevRequest({ ...calendar, context: [plain] }, [plain])).toBeNull();
    expect(buildJevRequest({ ...calendar, fields: [calendar.fields[3]!, calendar.fields[4]!] }, calendar.context)).toBeNull();
  });
});

describe('JevProvider', () => {
  it('posts to the Workers AI run endpoint and maps the chosen candidates to suggestions', async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({
        relevant: noul(0.93),
        field_f0: pick(keyOf('Dinner at Seven Shores Cafe'), 0.81, keys),
        field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.9, keys),
        field_f2: pick('none', 0.97, keys),
      }),
    );
    const out = await provider(fetchImpl).suggest(calendar, { signal: signal() });

    expect(out).toEqual([
      {
        kind: 'fill',
        fieldId: 'f1',
        value: '10 Regina St N, Waterloo, ON N2J 2Z8',
        confidence: 0.9,
        reason: 'street address in Seven Shores Cafe - Google Maps',
        sourceContextId: 'c2',
      },
      {
        kind: 'fill',
        fieldId: 'f0',
        value: 'Dinner at Seven Shores Cafe',
        confidence: 0.81,
        reason: 'plan (activity at a place) in Discord | #general | Waterloo Friends',
        sourceContextId: 'c1',
      },
    ]);

    const { url, init, body } = sent(fetchImpl);
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cf-token');
    expect(body.model).toBe('typesafe/jev');
    expect(body.input.state.context).toHaveLength(2);
    expect(body.input.questions.relevant!.type).toBe('noul');
    expect(body.input.questions.field_f1!.criteria).toHaveProperty('none');
    // Filled and credential fields are never asked about.
    expect(body.input.questions).not.toHaveProperty('field_f3');
    expect(body.input.questions).not.toHaveProperty('field_f4');
  });

  it('returns nothing for a field whose answer is none', async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({
        relevant: noul(0.9),
        field_f0: pick('none', 0.95, keys),
        field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.88, keys),
        field_f2: pick('none', 0.99, keys),
      }),
    );
    const out = await provider(fetchImpl).suggest(calendar, { signal: signal() });
    expect(fills(out).map((s) => s.fieldId)).toEqual(['f1']);
  });

  it('drops a chosen candidate under 0.7 and everything when the gate is under the minimum', async () => {
    const low = vi.fn(async () =>
      envelope({
        relevant: noul(0.9),
        field_f0: pick(keyOf('Dinner at Seven Shores Cafe'), 0.69, keys),
        field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.7, keys),
        field_f2: pick('none', 0.99, keys),
      }),
    );
    expect(fills(await provider(low).suggest(calendar, { signal: signal() })).map((s) => [s.fieldId, s.confidence])).toEqual([['f1', 0.7]]);

    const gated = vi.fn(async () =>
      envelope({
        relevant: noul(GATE_MIN - 0.01),
        field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.99, keys),
      }),
    );
    expect(await provider(gated).suggest(calendar, { signal: signal() })).toEqual([]);
  });

  it('ignores a choice key it never offered and a probability map that is missing the choice', async () => {
    const fetchImpl = vi.fn(async () =>
      envelope({
        relevant: noul(0.9),
        field_f0: { type: 'choice', choice: 'k99', confidence: 0.99, probabilities: { k99: 0.99 } },
        field_f1: { type: 'choice', choice: keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), confidence: 0.75, probabilities: {} },
      }),
    );
    const out = await provider(fetchImpl).suggest(calendar, { signal: signal() });
    expect(fills(out).map((s) => [s.fieldId, s.confidence])).toEqual([['f1', 0.75]]);
  });

  it('keeps at most two suggestions, highest confidence first', async () => {
    const wide: SuggestRequest = {
      ...calendar,
      fields: [
        { i: 'f0', t: 'input:text', al: 'Add title' },
        { i: 'f1', t: 'input:text', al: 'Add location' },
        { i: 'f2', t: 'input:tel', al: 'Phone' },
      ],
    };
    const fetchImpl = vi.fn(async () =>
      envelope({
        relevant: noul(0.9),
        field_f0: pick(keyOf('Dinner at Seven Shores Cafe'), 0.8, keys),
        field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.9, keys),
        field_f2: pick(keyOf('(519) 555-0142'), 0.85, keys),
      }),
    );
    const out = await provider(fetchImpl).suggest(wide, { signal: signal() });
    expect(fills(out).map((s) => s.fieldId)).toEqual(['f1', 'f2']);
  });

  it('returns [] on a Cloudflare error envelope, whatever the status', async () => {
    const body = { success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: null };
    for (const status of [200, 401, 400]) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
      expect(await provider(fetchImpl).suggest(calendar, { signal: signal() })).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('returns [] on a body it cannot parse', async () => {
    const html = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
    expect(await provider(html).suggest(calendar, { signal: signal() })).toEqual([]);
    const noAnswers = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { model: 'jev' } }), { status: 200 }));
    expect(await provider(noAnswers).suggest(calendar, { signal: signal() })).toEqual([]);
  });

  it('rejects on an HTTP failure without an envelope so the caller can fall back', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    await expect(provider(fetchImpl).suggest(calendar, { signal: signal() })).rejects.toThrow('HTTP 502');
  });

  it('returns [] when aborted mid-flight and never fetches on an aborted signal', async () => {
    const controller = new AbortController();
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = provider(hanging as unknown as typeof fetch).suggest(calendar, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual([]);

    const never = vi.fn();
    expect(await provider(never as unknown as typeof fetch).suggest(calendar, { signal: AbortSignal.abort() })).toEqual([]);
    expect(never).not.toHaveBeenCalled();
  });

  it('does not call Cloudflare at all when the regexes found no candidate or every source is the page itself', async () => {
    const fetchImpl = vi.fn();
    const plain = { ...discord, text: 'ok so who is around this weekend' };
    expect(await provider(fetchImpl as unknown as typeof fetch).suggest({ ...calendar, context: [plain] }, { signal: signal() })).toEqual([]);
    const self = { ...maps, origin: 'https://calendar.google.com' };
    expect(await provider(fetchImpl as unknown as typeof fetch).suggest({ ...calendar, context: [self] }, { signal: signal() })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never calls fetch as a method of the provider', async () => {
    const strict = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch': Illegal invocation");
      return Promise.resolve(envelope({ relevant: noul(0.9), field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.9, keys) }));
    } as unknown as typeof fetch;
    expect(fills(await provider(strict).suggest(calendar, { signal: signal() })).map((s) => s.fieldId)).toEqual(['f1']);
  });
});
