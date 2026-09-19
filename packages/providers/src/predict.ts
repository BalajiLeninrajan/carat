import type { Eagerness, ElementDescriptor, Entity, EntityKind, FieldDescriptor, InteractSuggestion, PageMeta, PredictInput, Settings, Suggestion } from '@carat/shared';
import { CONTROL_ROLES, DEFAULT_EAGERNESS, EAGERNESS, ENTITY_RESPONSE_FORMAT, EntityListSchema, MAX_ENTITIES, buildPredictMessages, isDestructiveName, verbFits } from '@carat/shared';
import type { Candidate } from './local/candidates';
import { classifyField, isNeverFill, type FieldKind } from './local/fields';
import type { OutputMode } from './openai-compat';
import { sameSite } from './same-site';

/** The whole prediction, request to parsed list. It runs off the chip's clock, so it gets less than the fast path's 6s. */
export const PREDICT_TIMEOUT_MS = 4000;

/** Reads one context item into the values the reader may type next. */
export interface Predictor {
  predict(input: PredictInput, opts: { signal: AbortSignal }): Promise<Entity[]>;
}

export interface EntityPredictorOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  mode: Exclude<OutputMode, 'prompt'>;
  /** Sent as `reasoning_effort: none` when true; only api.openai.com is known to take it. */
  reasoning: boolean;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/**
 * The chat model asked once per context item, with no fields: what would this
 * person type next, and where. One request, no retry; a transport error, an
 * HTTP error, a timeout and an unparseable reply all reject, so the caller
 * can fall back to the regex list and never cache the failure.
 */
export class EntityPredictor implements Predictor {
  constructor(
    readonly options: EntityPredictorOptions,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async predict(input: PredictInput, opts: { signal: AbortSignal }): Promise<Entity[]> {
    const body = {
      model: this.options.model,
      messages: buildPredictMessages(input),
      response_format: this.options.mode === 'json_schema' ? ENTITY_RESPONSE_FORMAT : { type: 'json_object' },
      ...(this.options.reasoning ? { reasoning_effort: 'none' } : {}),
    };
    // Chrome's fetch throws "Illegal invocation" with a non-global `this`, so never call it as this.fetchImpl(...).
    const { fetchImpl } = this;
    const res = await fetchImpl(`${this.options.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const completion = (await res.json()) as ChatCompletion;
    return parseEntities(completion.choices?.[0]?.message?.content);
  }
}

/**
 * The predictor for these settings, or undefined when there is no chat model
 * to ask: the local provider, or no key. The caller then uses the regex list.
 */
export function createEntityPredictor(settings: Settings, fetchImpl: typeof fetch = fetch): Predictor | undefined {
  if (settings.provider === 'local' || !settings.apiKey) return undefined;
  const openai = isOpenAI(settings.baseURL);
  return new EntityPredictor(
    { baseURL: settings.baseURL, apiKey: settings.apiKey, model: settings.model, mode: openai ? 'json_schema' : 'json_object', reasoning: openai },
    fetchImpl,
  );
}

function isOpenAI(baseURL: string): boolean {
  try {
    return new URL(baseURL).host === 'api.openai.com';
  } catch {
    return false;
  }
}

function parseEntities(content: unknown): Entity[] {
  if (typeof content !== 'string' || content.trim() === '') throw new Error('the reply had no text content');
  const text = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const data: unknown = JSON.parse(fenced ? fenced[1]! : text);
  const result = EntityListSchema.safeParse(Array.isArray(data) ? { entities: data } : data);
  if (!result.success) throw new Error(`schema mismatch (${result.error.issues.map((i) => i.message).join('; ')})`);
  return result.data.entities.filter((e) => e.value !== '').slice(0, MAX_ENTITIES);
}

// ---------------------------------------------------------------------------
// The regex list, in the same shape, for when there is no model to ask.

const REGEX_CONFIDENCE = 0.75;

/** The words a form uses for a field that takes each kind. Also what the regex list carries as hints. */
const KIND_HINTS: Record<EntityKind, readonly string[]> = {
  place: ['search', 'location', 'where', 'venue', 'place', 'destination'],
  address: ['location', 'address', 'where', 'venue', 'street'],
  event: ['title', 'subject', 'summary', 'event'],
  person: ['name', 'to', 'guests', 'attendees', 'recipient', 'who'],
  email: ['email', 'to', 'recipient', 'cc'],
  phone: ['phone', 'mobile', 'tel', 'telephone'],
  date: ['date', 'when', 'start', 'day'],
  time: ['time', 'start', 'when'],
  code: ['code', 'promo', 'coupon', 'reference', 'confirmation', 'order', 'booking'],
  other: [],
};

// A bare `name` has no kind of its own; the regex provider offers it at eager, so the level-free store never holds one.
const CANDIDATE_KIND: Record<Exclude<Candidate['kind'], 'name'>, EntityKind> = {
  email: 'email',
  phone: 'phone',
  address: 'address',
  place: 'place',
  plan: 'event',
  event: 'event',
};

/** The regex candidates of one item as entities: fixed confidence, the kind's usual field words as hints. */
export function entitiesFromCandidates(candidates: readonly Candidate[]): Entity[] {
  const seen = new Set<string>();
  const out: Entity[] = [];
  for (const c of candidates) {
    if (c.kind === 'name') continue;
    const kind = CANDIDATE_KIND[c.kind];
    const key = `${kind}\u0000${c.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: c.value, kind, fieldHints: [...KIND_HINTS[kind]], confidence: REGEX_CONFIDENCE });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching entities to the page, with no network.

/** Entities predicted from one context item, with where it came from so the page being filled is never its own source. */
export interface EntitySource {
  id: string;
  origin: string;
  entities: Entity[];
}

/** How well an entity fits, before the entity's own confidence. */
const STRENGTH = {
  /** A hint word, the input type or the autocomplete token names the entity's kind outright. */
  hint: 1,
  /** A hinted place into a location field when no address is on offer: right, though an address would be better. */
  placeAsLocation: 0.95,
  /** The field's classified kind takes this kind of value. */
  kind: 0.85,
  /** A plausible but second-choice pairing (a place as a title, an event as a search). */
  weak: 0.7,
  /** A control named by the entity's hints rather than its value. */
  named: 0.9,
  /** A select option equal to the value with nothing tying the entity to that select. */
  option: 0.8,
} as const;

/** Entity kinds a classified field takes outright, and the second choices. */
const FIELD_TAKES: Record<FieldKind, { strong: readonly EntityKind[]; weak: readonly EntityKind[] }> = {
  email: { strong: ['email'], weak: [] },
  phone: { strong: ['phone'], weak: [] },
  location: { strong: ['address', 'place'], weak: [] },
  title: { strong: ['event'], weak: ['place'] },
  search: { strong: ['place'], weak: ['event', 'address'] },
};

/** Input types that only take one kind; anything else into them is a mistake. */
const TYPE_KIND: Record<string, EntityKind> = {
  'input:email': 'email',
  'input:tel': 'phone',
  'input:date': 'date',
  'input:datetime-local': 'date',
  'input:time': 'time',
};

const MIN_CONTROL_NAME_CHARS = 4;

/**
 * Pair predicted entities with the page's fields and controls, locally and
 * synchronously. A fill's confidence is the entity's confidence times how
 * well it fits the field: a hint word on the field, the input type or the
 * autocomplete attribute is a full match; the field's classified kind is a
 * close one; a plausible second choice is weaker. One winner per field and
 * per element, over the level's confidence floor, best first. Controls: a checkbox,
 * switch or radio whose name the entity names gets `check`; a slider named
 * the same with a numeric value gets `set`; a select with an option equal to
 * the value gets `choose`. Buttons are never offered here; a click needs a
 * fill on the page first, which is the provider's call.
 */
export function matchEntities(
  sources: readonly EntitySource[],
  fields: readonly FieldDescriptor[],
  elements: readonly ElementDescriptor[],
  page: PageMeta,
  eagerness: Eagerness = DEFAULT_EAGERNESS,
): Suggestion[] {
  const floor = EAGERNESS[eagerness].minConfidence;
  const foreign = sources.filter((s) => !sameSite(s.origin, page.host));
  // An address belongs in a location field; while one is on offer a place only gets a weak claim there.
  const addressAvailable = foreign.some((s) => s.entities.some((e) => e.kind === 'address'));
  const out: Suggestion[] = [];

  for (const field of fields) {
    if (field.v || isNeverFill(field)) continue;
    const view = describeField(field);
    let best: Suggestion | undefined;
    for (const source of foreign) {
      for (const entity of source.entities) {
        const fit = fieldFit(entity, view, addressAvailable);
        if (!fit) continue;
        const confidence = round(entity.confidence * fit.strength);
        if (confidence < floor || (best && confidence <= best.confidence)) continue;
        best = { kind: 'fill', fieldId: field.i, value: entity.value, confidence, reason: fit.reason, sourceContextId: source.id };
      }
    }
    if (best) out.push(best);
  }

  for (const element of elements) {
    if (!CONTROL_ROLES.has(element.r) || isDestructiveName(element.nm)) continue;
    let best: InteractSuggestion | undefined;
    for (const source of foreign) {
      for (const entity of source.entities) {
        const fit = elementFit(entity, element);
        if (!fit) continue;
        const confidence = round(entity.confidence * fit.strength);
        if (confidence < floor || (best && confidence <= best.confidence)) continue;
        best = { kind: 'interact', elementId: element.i, verb: fit.verb, value: fit.value, confidence, reason: fit.reason, sourceContextId: source.id };
      }
    }
    if (best) out.push(best);
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}

interface FieldView {
  words: Set<string>;
  autocomplete: Set<string>;
  typeKind: EntityKind | undefined;
  search: boolean;
  classified: FieldKind | null;
}

function describeField(f: FieldDescriptor): FieldView {
  const words = new Set([f.nm, f.ph, f.al, f.lb, f.nb].filter(Boolean).flatMap((s) => tokens(s!)));
  return {
    words,
    autocomplete: new Set((f.ac ?? '').toLowerCase().split(/[\s-]+/).filter(Boolean)),
    typeKind: TYPE_KIND[f.t],
    search: f.t === 'input:search' || f.t === 'searchbox' || f.nm?.toLowerCase() === 'q',
    classified: classifyField(f),
  };
}

function fieldFit(entity: Entity, field: FieldView, addressAvailable: boolean): { strength: number; reason: string } | undefined {
  const label = `${entity.kind} "${entity.value}"`;
  if (field.typeKind) {
    return field.typeKind === entity.kind ? { strength: STRENGTH.hint, reason: `predicted ${label} matches the field's input type` } : undefined;
  }
  // An email or phone field takes nothing else, whatever the hints say.
  if ((field.classified === 'email' || field.classified === 'phone') && field.classified !== entity.kind) return undefined;
  if (field.autocomplete.has(entity.kind) || (entity.kind === 'address' && field.autocomplete.has('street'))) {
    return { strength: STRENGTH.hint, reason: `predicted ${label} matches the field's autocomplete` };
  }
  const hint = entity.fieldHints.find((h) => field.words.has(h) || field.autocomplete.has(h) || (h === 'search' && field.search));
  const placeAsLocation = entity.kind === 'place' && field.classified === 'location';
  if (hint) {
    const strength = placeAsLocation ? (addressAvailable ? STRENGTH.weak : STRENGTH.placeAsLocation) : STRENGTH.hint;
    return { strength, reason: `predicted ${label} was expected in a "${hint}" field` };
  }
  if (!field.classified) return undefined;
  const takes = FIELD_TAKES[field.classified];
  if (takes.strong.includes(entity.kind)) {
    const strength = placeAsLocation && addressAvailable ? STRENGTH.weak : STRENGTH.kind;
    return { strength, reason: `predicted ${label} fits a ${field.classified} field` };
  }
  if (takes.weak.includes(entity.kind)) return { strength: STRENGTH.weak, reason: `predicted ${label} may fit a ${field.classified} field` };
  return undefined;
}

function elementFit(entity: Entity, e: ElementDescriptor): { verb: InteractSuggestion['verb']; value: string; strength: number; reason: string } | undefined {
  const name = e.nm.trim();
  if (name.length < MIN_CONTROL_NAME_CHARS) return undefined;
  const nameWords = words(name);
  const hints = new Set(entity.fieldHints.map(singular));
  const named = nameWords.length > 0 && nameWords.every((w) => hints.has(singular(w)));
  const equalsName = entity.value.trim().toLowerCase() === name.toLowerCase();

  let fit: { verb: InteractSuggestion['verb']; value: string; strength: number; reason: string } | undefined;
  if (e.r === 'checkbox' || e.r === 'switch' || e.r === 'radio') {
    if (equalsName) fit = { verb: 'check', value: name, strength: STRENGTH.hint, reason: `predicted "${entity.value}" names this control` };
    else if (named) fit = { verb: 'check', value: name, strength: STRENGTH.named, reason: `predicted "${entity.value}" was expected at "${name}"` };
  } else if (e.r === 'slider') {
    if (named && Number.isFinite(Number(entity.value))) {
      fit = { verb: 'set', value: entity.value.trim(), strength: STRENGTH.named, reason: `predicted amount for "${name}"` };
    }
  } else if (e.r === 'select') {
    const option = (e.op ?? []).find((o) => o.toLowerCase() === entity.value.trim().toLowerCase());
    if (option) fit = { verb: 'choose', value: option, strength: named ? STRENGTH.hint : STRENGTH.option, reason: `predicted "${entity.value}" is an option of "${name}"` };
  }
  return fit && verbFits(e, fit.verb, fit.value) ? fit : undefined;
}

// Whole words, lowercase.
function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .filter((w) => w.length > 1);
}

// Both forms of a word, so a hint "guest" meets a field "guests" and the other way round.
function tokens(s: string): string[] {
  return words(s).flatMap((w) => (singular(w) === w ? [w] : [w, singular(w)]));
}

function singular(w: string): string {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
