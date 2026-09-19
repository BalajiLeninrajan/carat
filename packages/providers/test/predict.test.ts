import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ElementDescriptor, Entity, FieldDescriptor, PredictInput } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
import { EntityPredictor, createEntityPredictor, entitiesFromCandidates, matchEntities } from '../src/predict';
import type { EntitySource } from '../src/predict';
import { candidatesFrom } from '../src/local/candidates';
import { loadFixtures, type Fixture } from '../eval/fixtures';

let fixtures: Map<string, Fixture>;
beforeAll(async () => {
  fixtures = new Map((await loadFixtures()).map((f) => [f.name, f]));
});
const fixture = (name: string) => fixtures.get(name)!;

/** The regex list for every context item of a fixture, as the no-key path stores it. */
function regexSources(name: string): EntitySource[] {
  return fixture(name).request.context.map((c) => ({ id: c.id, origin: c.origin, entities: entitiesFromCandidates(candidatesFrom(c)) }));
}

const input: PredictInput = {
  origin: 'https://discord.com',
  title: 'Discord | #general',
  kind: 'page',
  text: 'alex: dinner at Seven Shores Cafe, Friday at 6?',
  now: '2026-09-16T14:04:00-04:00',
};

const place: Entity = { value: 'Seven Shores Cafe', kind: 'place', fieldHints: ['search', 'location', 'where'], confidence: 0.92 };
const event: Entity = { value: 'Dinner at Seven Shores Cafe', kind: 'event', fieldHints: ['title', 'subject', 'summary'], confidence: 0.8 };
const address: Entity = { value: '10 Regina St N, Waterloo, ON N2J 2Z8', kind: 'address', fieldHints: ['location', 'address', 'where'], confidence: 0.9 };

function completion(content: string | null, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status, headers: { 'content-type': 'application/json' } });
}

const openai = { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-5.6-luna', mode: 'json_schema' as const, reasoning: true };
const signal = () => new AbortController().signal;

describe('EntityPredictor', () => {
  it('posts the predict prompt with the strict entity schema and reasoning_effort none, and returns the parsed list', async () => {
    const fetchImpl = vi.fn(async () => completion(JSON.stringify({ entities: [place, { ...event, kind: 'plan' }] })));
    const out = await new EntityPredictor(openai, fetchImpl).predict(input, { signal: signal() });

    expect(out).toEqual([place, { ...event, kind: 'other' }]);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body.reasoning_effort).toBe('none');
    expect(body.response_format.json_schema.name).toBe('carat_entities');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(JSON.parse(body.messages.at(-1).content).text).toBe(input.text);
  });

  it('sends json_object and no reasoning_effort to a server that is not api.openai.com', async () => {
    const fetchImpl = vi.fn(async () => completion(JSON.stringify({ entities: [] })));
    const p = createEntityPredictor({ ...DEFAULT_SETTINGS, provider: 'baseten', apiKey: 'k', baseURL: 'https://model.baseten.co/v1' }, fetchImpl)!;
    expect(await p.predict(input, { signal: signal() })).toEqual([]);
    const [, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect('reasoning_effort' in body).toBe(false);
  });

  it('rejects on an HTTP error, an empty reply, malformed JSON and a schema miss, so the caller falls back', async () => {
    const cases = [completion(null, 500), completion(null), completion('not json'), completion(JSON.stringify({ entities: [{ value: 'x' }] }))];
    for (const res of cases) {
      const p = new EntityPredictor(openai, vi.fn(async () => res));
      await expect(p.predict(input, { signal: signal() })).rejects.toThrow();
    }
  });

  it('rejects when the signal fires before the reply', async () => {
    const fetchImpl = vi.fn((_: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const p = new EntityPredictor(openai, fetchImpl as unknown as typeof fetch);
    await expect(p.predict(input, { signal: AbortSignal.timeout(5) })).rejects.toThrow();
  });

  it('has no predictor for the local provider or an empty key', () => {
    expect(createEntityPredictor({ ...DEFAULT_SETTINGS, provider: 'local', apiKey: 'k' })).toBeUndefined();
    expect(createEntityPredictor({ ...DEFAULT_SETTINGS, apiKey: '' })).toBeUndefined();
    expect(createEntityPredictor({ ...DEFAULT_SETTINGS, apiKey: 'k' })).toBeInstanceOf(EntityPredictor);
  });
});

describe('entitiesFromCandidates', () => {
  it('maps every regex candidate kind to an entity kind with the kind\'s usual field words', () => {
    const out = entitiesFromCandidates(candidatesFrom(fixture('maps-calendar-location').request.context[0]!));
    expect(out.map((e) => [e.kind, e.value])).toEqual([
      ['phone', '(519) 555-0142'],
      ['address', '10 Regina St N, Waterloo, ON N2J 2Z8'],
      ['place', 'Seven Shores Cafe'],
    ]);
    expect(out.every((e) => e.confidence === 0.75 && e.fieldHints.length > 0)).toBe(true);
    expect(out[1]!.fieldHints).toContain('location');
  });

  it('turns a plan into an event and drops an exact repeat', () => {
    const out = entitiesFromCandidates([
      { kind: 'plan', value: 'Dinner at X', sourceContextId: 'a' },
      { kind: 'event', value: 'Dinner at X', sourceContextId: 'b' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('event');
    expect(out[0]!.fieldHints).toContain('title');
  });
});

describe('matchEntities', () => {
  it('fills the Maps search box with the Discord place, from the regex list and from the model list', () => {
    const { request } = fixture('discord-maps-search');
    const regex = matchEntities(regexSources('discord-maps-search'), request.fields, [], request.page);
    expect(regex).toEqual([expect.objectContaining({ kind: 'fill', fieldId: 'f0', value: 'Seven Shores Cafe', sourceContextId: 'c1' })]);
    expect(regex[0]!.confidence).toBeGreaterThanOrEqual(0.7);

    const model = matchEntities([{ id: 'c1', origin: 'https://discord.com', entities: [place, event] }], request.fields, [], request.page);
    expect(model.map((s) => s.kind === 'fill' && [s.fieldId, s.value])).toEqual([['f0', 'Seven Shores Cafe']]);
    expect(model[0]!.confidence).toBe(0.92);
  });

  it('puts the Maps address in the Calendar location field and the Discord title in the title field, nothing in description or guests', () => {
    const { request } = fixture('maps-calendar-location');
    for (const sources of [
      regexSources('maps-calendar-location'),
      [
        { id: 'c2', origin: 'https://www.google.com', entities: [address, { ...place, confidence: 0.95 }] },
        { id: 'c1', origin: 'https://discord.com', entities: [place, event] },
      ],
    ]) {
      const out = matchEntities(sources, request.fields, [], request.page);
      const byField = new Map(out.map((s) => [s.kind === 'fill' ? s.fieldId : '', s]));
      expect(byField.get('f1')).toMatchObject({ value: '10 Regina St N, Waterloo, ON N2J 2Z8', sourceContextId: 'c2' });
      expect(byField.get('f0')).toMatchObject({ value: 'Dinner at Seven Shores Cafe', sourceContextId: 'c1' });
      expect(byField.has('f2')).toBe(false);
      expect(byField.has('f3')).toBe(false);
    }
  });

  it('offers nothing for a search box after a news article, from either list', () => {
    const { request } = fixture('neg-news-search');
    expect(matchEntities(regexSources('neg-news-search'), request.fields, [], request.page)).toEqual([]);
    const timid: Entity = { value: 'Parliament Hill', kind: 'place', fieldHints: ['search'], confidence: 0.4 };
    expect(matchEntities([{ id: 'c1', origin: 'https://www.cbc.ca', entities: [timid] }], request.fields, [], request.page)).toEqual([]);
  });

  it('never fills from the page\'s own site, over a value, or into a credential field', () => {
    const page = { host: 'calendar.google.com', title: 'Calendar', path: '/r/eventedit' };
    const own: EntitySource = { id: 'c9', origin: 'https://calendar.google.com', entities: [address] };
    const fields: FieldDescriptor[] = [
      { i: 'f0', t: 'input:text', al: 'Add location' },
      { i: 'f1', t: 'input:text', al: 'Add location', v: 'typed' },
      { i: 'f2', t: 'input:text', al: 'Location code', ac: 'one-time-code' },
    ];
    expect(matchEntities([own], fields, [], page)).toEqual([]);
    const other = { ...own, origin: 'https://www.google.com' };
    expect(matchEntities([other], fields, [], page).map((s) => s.kind === 'fill' && s.fieldId)).toEqual(['f0']);
  });

  it('respects the input type and autocomplete: an email never lands in a tel field, a phone lands in one', () => {
    const page = { host: 'forms.example.org', title: 'Form', path: '/' };
    const email: Entity = { value: 'maya@northbrook.com', kind: 'email', fieldHints: ['to', 'phone'], confidence: 0.9 };
    const phone: Entity = { value: '(519) 555-0142', kind: 'phone', fieldHints: [], confidence: 0.85 };
    const fields: FieldDescriptor[] = [
      { i: 'f0', t: 'input:tel', lb: 'Phone' },
      { i: 'f1', t: 'input:text', ac: 'email', lb: 'Contact' },
      { i: 'f2', t: 'input:text', lb: 'Street', ac: 'street-address' },
    ];
    const out = matchEntities([{ id: 'c1', origin: 'https://app.slack.com', entities: [email, phone, address] }], fields, [], page);
    expect(out.map((s) => s.kind === 'fill' && [s.fieldId, s.value])).toEqual(
      expect.arrayContaining([
        ['f0', '(519) 555-0142'],
        ['f1', 'maya@northbrook.com'],
        ['f2', '10 Regina St N, Waterloo, ON N2J 2Z8'],
      ]),
    );
    expect(out).toHaveLength(3);
  });

  it('checks a control the entity names, sets a slider from a numeric value, chooses a matching option, and never touches a button', () => {
    const page = { host: 'forms.example.org', title: 'Form', path: '/' };
    const elements: ElementDescriptor[] = [
      { i: 'e0', r: 'checkbox', nm: 'Vegetarian', st: 'off' },
      { i: 'e1', r: 'checkbox', nm: 'Vegan', st: 'off' },
      { i: 'e2', r: 'slider', nm: 'Volume', v: '80', min: 0, max: 100 },
      { i: 'e3', r: 'select', nm: 'Show as', v: 'Busy', op: ['Busy', 'Free'] },
      { i: 'e4', r: 'button', nm: 'Submit RSVP', p: 1 },
      { i: 'e5', r: 'button', nm: 'Delete' },
      { i: 'e6', r: 'checkbox', nm: 'Vegetarian', st: 'on' },
    ];
    const entities: Entity[] = [
      { value: 'Vegetarian', kind: 'other', fieldHints: ['dietary', 'diet'], confidence: 0.9 },
      { value: '40', kind: 'other', fieldHints: ['volume'], confidence: 0.85 },
      { value: 'free', kind: 'other', fieldHints: ['availability'], confidence: 0.9 },
      { value: 'Submit RSVP', kind: 'other', fieldHints: ['submit'], confidence: 0.99 },
      { value: 'Delete', kind: 'other', fieldHints: ['delete'], confidence: 0.99 },
    ];
    const out = matchEntities([{ id: 'c1', origin: 'https://app.slack.com', entities }], [], elements, page);
    expect(out.map((s) => s.kind === 'interact' && [s.elementId, s.verb, s.value])).toEqual([
      ['e0', 'check', 'Vegetarian'],
      ['e2', 'set', '40'],
      ['e3', 'choose', 'Free'],
    ]);
    expect(out.map((s) => s.confidence)).toEqual([0.9, 0.765, 0.72]);
  });
});
