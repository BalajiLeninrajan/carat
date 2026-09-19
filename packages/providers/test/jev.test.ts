import { describe, expect, it, vi } from 'vitest';
import type { Eagerness, FillSuggestion, InteractSuggestion, SuggestRequest, Suggestion } from '@carat/shared';
import { EAGERNESS, EAGERNESS_LEVELS } from '@carat/shared';
import { JevProvider } from '../src/jev';
import { buildJevRequest, fillRules } from '../src/jev/request';

const signal = () => new AbortController().signal;
const fills = (out: Suggestion[]): FillSuggestion[] => out.filter((s): s is FillSuggestion => s.kind === 'fill');
const interactions = (out: Suggestion[]): InteractSuggestion[] => out.filter((s): s is InteractSuggestion => s.kind === 'interact');

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

// Title and location already filled from c2 and c1, so no field is asked about; the Save button is the next step.
const afterFills: SuggestRequest = {
  page: calendar.page,
  fields: [{ i: 'f0', t: 'input:text', al: 'Add title', v: 'Dinner at Seven Shores Cafe' }],
  elements: [
    { i: 'e0', r: 'button', nm: 'Save', p: 1 },
    { i: 'e1', r: 'button', nm: 'Delete event' },
    { i: 'e2', r: 'button', nm: 'More options' },
    { i: 'e3', r: 'slider', nm: 'Reminder minutes', v: '10', min: 0, max: 60 },
    { i: 'e4', r: 'select', nm: 'Show as', v: 'Busy', op: ['Busy', 'Free'] },
    { i: 'e5', r: 'switch', nm: 'All day', st: 'on' },
    { i: 'e6', r: 'checkbox', nm: 'Private', st: 'off' },
  ],
  filled: ['c2', 'c1'],
  context: [maps, { ...discord, text: 'dinner at Seven Shores Cafe, Friday at 6? not an all day thing' }],
  now: calendar.now,
};

const rsvp: SuggestRequest = {
  page: { host: 'forms.example.org', title: 'Team offsite RSVP', path: '/rsvp' },
  fields: [{ i: 'f0', t: 'textarea', nm: 'notes', lb: 'Anything else?' }],
  elements: [
    { i: 'e0', r: 'checkbox', nm: 'Vegetarian', st: 'off' },
    { i: 'e1', r: 'checkbox', nm: 'Vegan', st: 'off' },
    { i: 'e2', r: 'button', nm: 'Submit RSVP', p: 1 },
  ],
  context: [{ id: 'c1', origin: 'https://app.slack.com', title: 'Slack', kind: 'page', text: "I'm a vegetarian, no other restrictions", capturedAt: 1 }],
  now: calendar.now,
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

function provider(fetchImpl: typeof fetch, eagerness?: Eagerness) {
  return new JevProvider({ accountId: 'acct-1', apiToken: 'cf-token', ...(eagerness ? { eagerness } : {}) }, fetchImpl);
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

  it('asks one choice over the elements: buttons only after fills, toggles only when a context item names them', () => {
    const b = buildJevRequest(afterFills, afterFills.context)!;
    expect(Object.keys(b.questions)).toEqual(['interact']);
    expect(b.state).not.toHaveProperty('fields');
    expect(b.state.filled).toEqual(['c2', 'c1']);
    expect(b.interactOptions.map((o) => [o.key, o.verb, o.sourceContextId])).toEqual([
      ['e0', 'click', 'c2'],
      ['e2', 'click', 'c2'],
      ['e5', 'uncheck', 'c1'],
    ]);
    const criteria = b.questions.interact!.criteria as Record<string, unknown>;
    expect(Object.keys(criteria)).toEqual(['e0', 'e2', 'e5', 'none']);
    expect(criteria.e0).toMatchObject({ action: 'click "Save"', role: 'button', primary: true });

    // Without a fill, only the primary action is asked about, and only at eager with nothing left to fill (the title has a value);
    // it cites the newest context item. Below eager no button is asked about, and a slider or select never is.
    const noFill = buildJevRequest({ ...afterFills, filled: undefined }, afterFills.context)!;
    expect(noFill.interactOptions.map((o) => [o.key, o.sourceContextId])).toEqual([['e0', 'c2'], ['e5', 'c1']]);
    const noFillBalanced = buildJevRequest({ ...afterFills, filled: undefined }, afterFills.context, 'balanced')!;
    expect(noFillBalanced.interactOptions.map((o) => o.key)).toEqual(['e5']);
    const noFillWithField = buildJevRequest({ ...afterFills, filled: undefined, fields: [{ i: 'f0', t: 'input:text', al: 'Add title' }] }, afterFills.context)!;
    expect(noFillWithField.interactOptions.map((o) => o.key)).toEqual(['e5']);
    const vegetarian = buildJevRequest(rsvp, rsvp.context)!;
    expect(Object.keys(vegetarian.questions)).toEqual(['interact']);
    expect(vegetarian.interactOptions.map((o) => [o.key, o.verb, o.sourceContextId])).toEqual([['e0', 'check', 'c1']]);
  });

  it('asks about a real link only while the page has a query it relates to, and tells Jev the destination site', () => {
    const serp: SuggestRequest = {
      page: { host: 'www.google.com', title: 'food delivery near me - Google Search', path: '/search', query: 'food delivery near me' },
      fields: [],
      elements: [
        { i: 'e0', r: 'button', nm: 'Search', p: 1 },
        { i: 'e1', r: 'link', nm: 'Order Now | Quick and Easy Food Delivery', h: 'doordash.com' },
        { i: 'e2', r: 'link', nm: 'Waterloo weather', h: 'weathernetwork.com' },
        { i: 'e3', r: 'link', nm: 'Sign out' },
      ],
      context: [],
      now: calendar.now,
    };
    const b = buildJevRequest(serp, [])!;
    expect(b.interactOptions.map((o) => [o.key, o.verb, o.sourceContextId])).toEqual([['e1', 'click', 'page']]);
    expect((b.questions.interact!.criteria as Record<string, unknown>).e1).toMatchObject({ action: 'click "Order Now | Quick and Easy Food Delivery"', site: 'doordash.com' });

    // No query on the page: a real link is no one's to follow, however much carat filled. The Search button still is.
    const { query: _q, ...page } = serp.page;
    expect(buildJevRequest({ ...serp, page }, [])).toBeNull();
    expect(buildJevRequest({ ...serp, page, filled: ['c1'] }, [])!.interactOptions.map((o) => o.key)).toEqual(['e0']);
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

  it('drops a chosen candidate under the level\'s floor, reporting it, and everything when the gate is under the level\'s minimum', async () => {
    for (const level of EAGERNESS_LEVELS) {
      const { minConfidence: floor, jevGateMin } = EAGERNESS[level];
      const low = vi.fn(async () =>
        envelope({
          relevant: noul(jevGateMin),
          field_f0: pick(keyOf('Dinner at Seven Shores Cafe'), floor - 0.01, keys),
          field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), floor, keys),
          field_f2: pick('none', 0.99, keys),
        }),
      );
      const dropped: Suggestion[] = [];
      const out = await provider(low, level).suggest(calendar, { signal: signal(), onUnderFloor: (s) => void dropped.push(s) });
      expect(fills(out).map((s) => [s.fieldId, s.confidence]), level).toEqual([['f1', floor]]);
      expect(dropped.map((s) => s.kind === 'fill' && s.fieldId), level).toEqual(['f0']);

      const gated = vi.fn(async () =>
        envelope({
          relevant: noul(jevGateMin - 0.01),
          field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.99, keys),
        }),
      );
      expect(await provider(gated, level).suggest(calendar, { signal: signal() }), level).toEqual([]);
    }
    expect(EAGERNESS.eager.jevGateMin).toBe(0.25);
    expect(EAGERNESS.balanced.jevGateMin).toBe(0.5);
    expect(EAGERNESS.conservative.jevGateMin).toBe(0.6);
  });

  it('asks with the fill rule of its level: quiet when conservative, leaning in when eager', async () => {
    expect(fillRules('conservative').at(-1)).toBe('When unsure, pick `none`. No suggestion beats a wrong one.');
    expect(fillRules('eager').at(-1)).toMatch(/^Lean toward picking/);
    expect(fillRules('eager').slice(0, -1)).toEqual(fillRules('conservative').slice(0, -1));
    const fetchImpl = vi.fn(async () => envelope({ relevant: noul(0.9), field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.9, keys) }));
    await provider(fetchImpl, 'eager').suggest(calendar, { signal: signal() });
    const { body } = sent(fetchImpl);
    const rules = (body.input.questions.relevant as unknown as { instructions: { rules: string[] } }).instructions.rules;
    expect(rules.at(-1)).toMatch(/^Lean toward picking/);
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

  it('keeps at most two suggestions below eager and four at eager, highest confidence first', async () => {
    const wide: SuggestRequest = {
      ...calendar,
      fields: [
        { i: 'f0', t: 'input:text', al: 'Add title' },
        { i: 'f1', t: 'input:text', al: 'Add location' },
        { i: 'f2', t: 'input:tel', al: 'Phone' },
      ],
    };
    const reply = () =>
      vi.fn(async () =>
        envelope({
          relevant: noul(0.9),
          field_f0: pick(keyOf('Dinner at Seven Shores Cafe'), 0.8, keys),
          field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.9, keys),
          field_f2: pick(keyOf('(519) 555-0142'), 0.85, keys),
        }),
      );
    expect(fills(await provider(reply(), 'balanced').suggest(wide, { signal: signal() })).map((s) => s.fieldId)).toEqual(['f1', 'f2']);
    expect(fills(await provider(reply(), 'conservative').suggest(wide, { signal: signal() })).map((s) => s.fieldId)).toEqual(['f1', 'f2']);
    expect(fills(await provider(reply(), 'eager').suggest(wide, { signal: signal() })).map((s) => s.fieldId)).toEqual(['f1', 'f2', 'f0']);
    expect(EAGERNESS.eager.maxSuggestions).toBe(4);
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

  it('does not call Cloudflare at all when the regexes found no candidate or, below eager, every source is on the page\'s own site', async () => {
    const fetchImpl = vi.fn();
    const plain = { ...discord, text: 'ok so who is around this weekend' };
    expect(await provider(fetchImpl as unknown as typeof fetch).suggest({ ...calendar, context: [plain] }, { signal: signal() })).toEqual([]);
    const self = { ...maps, origin: 'https://calendar.google.com' };
    for (const level of ['conservative', 'balanced'] as const) {
      expect(await provider(fetchImpl as unknown as typeof fetch, level).suggest({ ...calendar, context: [self] }, { signal: signal() })).toEqual([]);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    // At eager, another Calendar tab is a source; the orchestrator never lists the requesting tab itself under context.
    const eager = vi.fn(async () => envelope({ relevant: noul(0.9) }));
    await provider(eager, 'eager').suggest({ ...calendar, context: [self] }, { signal: signal() });
    expect(eager).toHaveBeenCalledTimes(1);
  });

  it('never calls fetch as a method of the provider', async () => {
    const strict = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch': Illegal invocation");
      return Promise.resolve(envelope({ relevant: noul(0.9), field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.9, keys) }));
    } as unknown as typeof fetch;
    expect(fills(await provider(strict).suggest(calendar, { signal: signal() })).map((s) => s.fieldId)).toEqual(['f1']);
  });

  it('turns the interaction choice into one interact suggestion with the element name as value', async () => {
    const fetchImpl = vi.fn(async () => envelope({ interact: pick('e0', 0.9, ['e0', 'e2', 'e5', 'none']) }));
    const out = await provider(fetchImpl).suggest(afterFills, { signal: signal() });
    expect(out).toEqual([
      { kind: 'interact', elementId: 'e0', verb: 'click', value: 'Save', confidence: 0.9, reason: 'carat just filled fields on this page', sourceContextId: 'c2' },
    ]);
    const { body } = sent(fetchImpl);
    expect(body.input.questions.interact!.type).toBe('choice');
    expect(body.input.questions).not.toHaveProperty('relevant');

    const check = vi.fn(async () => envelope({ interact: pick('e0', 0.8, ['e0', 'none']) }));
    expect(interactions(await provider(check).suggest(rsvp, { signal: signal() }))).toEqual([
      expect.objectContaining({ elementId: 'e0', verb: 'check', value: 'Vegetarian', confidence: 0.8, sourceContextId: 'c1' }),
    ]);
  });

  it('offers no interaction on none, under the level\'s threshold, or for an element it never asked about', async () => {
    for (const answer of [pick('none', 0.95, ['e0', 'e2', 'e5', 'none']), pick('e0', 0.69, ['e0', 'e2', 'e5', 'none']), pick('e1', 0.99, ['e1'])]) {
      const fetchImpl = vi.fn(async () => envelope({ interact: answer }));
      expect(await provider(fetchImpl, 'conservative').suggest(afterFills, { signal: signal() })).toEqual([]);
    }
    // The same 0.69 click clears the eager floor.
    const eager = vi.fn(async () => envelope({ interact: pick('e0', 0.69, ['e0', 'e2', 'e5', 'none']) }));
    expect(interactions(await provider(eager, 'eager').suggest(afterFills, { signal: signal() })).map((s) => s.confidence)).toEqual([0.69]);
  });

  it('answers fills and the interaction from one call, each gated on its own', async () => {
    const mixed: SuggestRequest = { ...calendar, elements: rsvp.elements, filled: ['c1'] };
    const b = buildJevRequest(mixed, mixed.context)!;
    const ikeys = [...b.interactOptions.map((o) => o.key), 'none'];
    // Buttons after a fill, plus nothing for the checkboxes: no context names them.
    expect(ikeys).toEqual(['e2', 'none']);
    const fetchImpl = vi.fn(async () =>
      envelope({
        relevant: noul(0.2),
        field_f1: pick(keyOf('10 Regina St N, Waterloo, ON N2J 2Z8'), 0.95, keys),
        interact: pick('e2', 0.85, ikeys),
      }),
    );
    const out = await provider(fetchImpl).suggest(mixed, { signal: signal() });
    expect(fills(out)).toEqual([]);
    expect(interactions(out).map((s) => [s.elementId, s.verb, s.sourceContextId])).toEqual([['e2', 'click', 'c1']]);
  });
});
