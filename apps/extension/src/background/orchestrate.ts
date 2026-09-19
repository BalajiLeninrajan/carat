import type {
  ActionSuggestion,
  ElementDescriptor,
  FieldDescriptor,
  FillSuggestion,
  InteractSuggestion,
  PageMeta,
  RequestContext,
  Settings,
  SuggestRequest,
  Suggestion,
} from '@carat/shared';
import { LIMITS, fnv1a, impliedVerb, isDestructiveName, isIntentName, isOffScreen, mergeSuggestions, verbFits } from '@carat/shared';
import type { Provider } from '@carat/providers';
import { LocalProvider, createProvider, createSmartProvider } from '@carat/providers';
import type { InteractionView, RefineResponse, SuggestResponse, SuggestionSource, SuggestionView } from '../messaging';
import type { ContextStore } from '../store';
import { interactSuppressionKey, navSuppressionKey, suppressionPrefix } from '../store';
import type { GateVerdict, ProviderAttempt, SuggestDiag } from './diag';
import { fingerprintMatchesDescriptor } from './fingerprint';
import { explainGate } from './gate';
import type { OpenTab } from './navigation';
import { resolveNavigation } from './navigation';
import type { RefineQueue } from './refine';
import type { Requester } from './requester';
import { ownContext, scoreAndPickContext } from './score';
import type { VisionPipeline } from './vision';

export interface SuggestInput {
  page: PageMeta;
  fields: FieldDescriptor[];
  elements?: ElementDescriptor[];
  /** The user asked with the shortcut: ask the provider again and show what they dismissed. */
  force?: boolean;
}

export interface OrchestrateDeps {
  store: ContextStore;
  settings: () => Promise<Settings>;
  createProvider?: (settings: Settings) => Provider;
  localProvider?: Provider;
  now?: () => number;
  timeoutMs?: number;
  /** Told how each request went, for the popup's debug line. */
  onDiag?: (diag: SuggestDiag) => void;
  /** The user's open tabs, read only to turn "open" into "focus". Never written to here. */
  tabs?: () => Promise<OpenTab[]>;
  /** The smart second pass. `refine` and `vision` must both be present for one to start. */
  createSmartProvider?: (settings: Settings) => Provider | undefined;
  refine?: RefineQueue;
  vision?: Pick<VisionPipeline, 'hasPending' | 'settled'>;
  smartTimeoutMs?: number;
}

const NONE: SuggestResponse = { suggestions: [], navigation: [], interactions: [] };

/** Gate verdicts a transcript still on its way could overturn. */
const CONTEXT_VERDICTS: ReadonlySet<GateVerdict> = new Set(['no-context', 'stale-context', 'own-context']);

/**
 * The fast path answers from text context on the configured provider inside
 * one 6s budget and returns. When that answer is weak, or a screenshot is
 * still being read, a smart call starts in the background on the vision
 * model; its result is handed back through the ticket and written to the
 * cache, and the fast reply never waits for it.
 */
export async function orchestrate(input: SuggestInput, requester: Requester, deps: OrchestrateDeps): Promise<SuggestResponse> {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? LIMITS.providerTimeoutMs;
  const { store } = deps;
  const diag: SuggestDiag = { at: now(), host: input.page.host, fields: input.fields.length, gate: 'ok' };

  const settings = await deps.settings();
  const items = await store.items();
  const elements = input.elements ?? [];
  diag.elements = elements.length;
  // What carat itself filled on this tab in the last minute; the only thing that earns a button a chip.
  const filled = requester.tabId === undefined ? [] : await store.recentFillSources(requester.tabId);
  // Freshness follows the store's clock, which stands still while pinned.
  const at = await store.clock();
  diag.gate = explainGate({ ...input, elements, filled }, items, settings, requester, at);
  const smart = smartPath(settings, deps, requester);
  const shape: Shape = { input, elements, filled, store };
  if (diag.gate !== 'ok') {
    const result: SuggestResponse = { ...NONE };
    // Nothing to read yet, but a screenshot is being transcribed: the smart pass alone may have an answer.
    if (smart?.pending && CONTEXT_VERDICTS.has(diag.gate)) {
      result.ticket = smart.queue.add(requester.tabId, smartSuggest(shape, requester, [], smart, deps, now));
      diag.refine = true;
    }
    deps.onDiag?.(diag);
    return result;
  }

  const context = scoreAndPickContext(items, requester, at);
  const own = ownContext(items, requester, at);
  if (context.length === 0 && own.length === 0) {
    deps.onDiag?.(diag);
    return NONE;
  }

  const key = cacheKey(input, elements, filled, context, own);
  const cached = input.force ? undefined : await store.getCached(key);
  diag.cached = cached !== undefined;
  let suggestions: Suggestion[];
  if (cached) {
    // The key ignores what is scrolled into view, so a cached scroll may now name an on-screen element.
    suggestions = valid(cached, input.fields, elements, filled, context, own);
  } else {
    const outcome = await callProvider(request(shape, context, own, now()), settings, deps, timeoutMs);
    diag.attempts = outcome.attempts;
    suggestions = valid(outcome.suggestions, input.fields, elements, filled, context, own);
    // A transport error or timeout is not "nothing to suggest": caching it
    // would hide chips for a minute after one blip. Only a real answer is kept.
    if (!outcome.failed) await store.setCached(key, suggestions);
  }

  const offered = await offer(suggestions, shape, context, own);
  const tabs = offered.actions.length > 0 ? await (deps.tabs ?? noTabs)().catch(() => []) : [];
  const navigation = resolveNavigation(offered.actions, tabs, requester, input.page)
    .slice(0, LIMITS.maxNavigations)
    .map(offered.withSource);
  const result: SuggestResponse = { suggestions: offered.fills, navigation, interactions: offered.interactions };
  // Only a fresh answer, or one a transcript may still improve, is worth a second opinion; and only
  // when there is (or will be) other tabs' text to answer from, since tab offers are never refined.
  const worthAsking = smart && (context.length > 0 || smart.pending) && (!diag.cached || smart.pending);
  if (worthAsking && weak([...result.suggestions, ...result.interactions])) {
    result.ticket = smart.queue.add(requester.tabId, smartSuggest(shape, requester, suggestions, smart, deps, now));
    diag.refine = true;
  }
  diag.offered = result.suggestions.length;
  diag.navigation = navigation.length;
  diag.interactions = result.interactions.length;
  deps.onDiag?.(diag);
  return result;
}

/** The parts of one request that both passes share. */
interface Shape {
  input: SuggestInput;
  elements: ElementDescriptor[];
  filled: string[];
  store: ContextStore;
}

interface SmartPath {
  provider: Provider;
  queue: RefineQueue;
  vision: Pick<VisionPipeline, 'hasPending' | 'settled'>;
  /** A screenshot from another tab is being read right now. */
  pending: boolean;
}

function smartPath(settings: Settings, deps: OrchestrateDeps, requester: Requester): SmartPath | undefined {
  if (!settings.screenshots || !deps.refine || !deps.vision) return undefined;
  let provider: Provider | undefined;
  try {
    provider = (deps.createSmartProvider ?? createSmartProvider)(settings);
  } catch {
    return undefined;
  }
  if (!provider) return undefined;
  return { provider, queue: deps.refine, vision: deps.vision, pending: deps.vision.hasPending(requester) };
}

/** Nothing shown, or nothing the model was sure of. */
function weak(shown: Array<{ confidence: number }>): boolean {
  return shown.every((s) => s.confidence < LIMITS.smartBelowConfidence);
}

/**
 * Wait for any screenshot still being read (it is the context most likely to
 * change the answer), re-pick context, ask the smart model, and fold its
 * answer over the fast one: per field or element the surer one wins, and tab
 * offers stay as they were. The merged answer replaces the cache entry so the
 * next fast request on this page starts from it.
 */
async function smartSuggest(
  shape: Shape,
  requester: Requester,
  fast: Suggestion[],
  smart: SmartPath,
  deps: OrchestrateDeps,
  now: () => number,
): Promise<RefineResponse> {
  const budget = deps.smartTimeoutMs ?? LIMITS.smartTimeoutMs;
  const deadline = Date.now() + budget;
  // Leave the model at least a fifth of the budget however long the transcription takes.
  await Promise.race([smart.vision.settled(), sleep(budget * 0.8)]);

  const { store, input, elements, filled } = shape;
  const items = await store.items();
  const at = await store.clock();
  const context = scoreAndPickContext(items, requester, at);
  const own = ownContext(items, requester, at);
  const remaining = deadline - Date.now();
  if (context.length === 0 || remaining < MIN_SMART_MS) return { suggestions: [], interactions: [] };

  let answer: Suggestion[];
  try {
    answer = valid(await withTimeout(smart.provider, request(shape, context, own, now()), remaining), input.fields, elements, filled, context, own);
  } catch {
    return { suggestions: [], interactions: [] };
  }
  const merged = mergeSuggestions(fast, answer);
  await store.setCached(cacheKey(input, elements, filled, context, own), merged);
  const offered = await offer(merged, shape, context, own);
  return { suggestions: offered.fills, interactions: offered.interactions };
}

const MIN_SMART_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(shape: Shape, context: RequestContext, own: RequestContext, now: number): SuggestRequest {
  const { input, elements, filled } = shape;
  return {
    page: input.page,
    fields: input.fields,
    ...(elements.length > 0 ? { elements } : {}),
    ...(filled.length > 0 ? { filled } : {}),
    context,
    ...(own.length > 0 ? { own } : {}),
    now: new Date(now).toISOString(),
    ...(typeof navigator !== 'undefined' && navigator.language ? { locale: navigator.language } : {}),
  };
}

/**
 * What the chip may show: minus what the user already accepted or dismissed
 * (unless they asked out loud), one per field, element or intent, top two,
 * each tagged with where its text came from.
 */
async function offer(suggestions: Suggestion[], shape: Shape, context: RequestContext, own: RequestContext) {
  const { input, elements, store } = shape;
  const suppressed = input.force ? [] : await store.suppressedKeys();
  const fills = suggestions.filter(isFill).filter((s) => !isSuppressed(s, input, suppressed));
  const actions = suggestions.filter(isAction).filter((a) => !suppressed.includes(navSuppressionKey(a.intent, a.value)));
  const interactions = suggestions.filter(isInteract).filter((s) => {
    const el = elements.find((e) => e.i === s.elementId);
    return !!el && !suppressed.includes(interactSuppressionKey(input.page.host, el.r, el.nm));
  });
  const sources = new Map([...context, ...own].map((c) => [c.id, sourceOf(c)] as const));
  const withSource = <T extends { sourceContextId: string }>(s: T): T & { source?: SuggestionSource } => ({
    ...s,
    ...(sources.has(s.sourceContextId) ? { source: sources.get(s.sourceContextId) } : {}),
  });
  return {
    fills: topPerField(fills).slice(0, LIMITS.maxSuggestions).map(withSource) as SuggestionView[],
    actions: topPerIntent(actions),
    interactions: topPerElement(interactions).slice(0, LIMITS.maxSuggestions).map(withSource) as InteractionView[],
    withSource,
  };
}

// The chip may say where a value came from; the text it came from stays here.
function sourceOf(c: RequestContext[number]): SuggestionSource {
  let host = c.origin;
  try {
    host = new URL(c.origin).host;
  } catch {
    // origin is already a bare host
  }
  return { host, capturedAt: c.capturedAt };
}

export interface ProviderOutcome {
  suggestions: Suggestion[];
  attempts: ProviderAttempt[];
  /** True when the provider the user configured never gave an answer. */
  failed: boolean;
}

const noTabs = async (): Promise<OpenTab[]> => [];
const isFill = (s: Suggestion): s is FillSuggestion => s.kind === 'fill';
const isAction = (s: Suggestion): s is ActionSuggestion => s.kind === 'action';
const isInteract = (s: Suggestion): s is InteractSuggestion => s.kind === 'interact';

/**
 * One 6s budget covers the whole call. A failing network provider degrades to
 * the regex provider on whatever budget is left (with a small floor, since the
 * regex pass is near-instant); a slow local provider degrades to nothing.
 */
async function callProvider(
  req: SuggestRequest,
  settings: Settings,
  deps: OrchestrateDeps,
  timeoutMs: number,
): Promise<ProviderOutcome> {
  const local = deps.localProvider ?? new LocalProvider();
  const deadline = Date.now() + timeoutMs;
  const floor = Math.min(FALLBACK_FLOOR_MS, timeoutMs);
  const attempts: ProviderAttempt[] = [];

  let provider: Provider;
  try {
    provider = (deps.createProvider ?? createProvider)(settings);
  } catch (e) {
    attempts.push({ id: settings.provider, ms: 0, count: 0, error: describeError(e) });
    provider = local;
  }

  const first = await attempt(provider, req, timeoutMs);
  attempts.push(first);
  if (!first.error) {
    // An empty answer from the network provider with no key configured means
    // it was never really asked; give the regex pass a turn.
    if (first.count > 0 || provider.id === 'local' || settings.apiKey) {
      return { suggestions: first.suggestions, attempts, failed: false };
    }
  } else if (provider.id === 'local') {
    return { suggestions: [], attempts, failed: true };
  }

  const second = await attempt(local, req, Math.max(floor, deadline - Date.now()));
  attempts.push(second);
  return { suggestions: second.suggestions, attempts, failed: first.error !== undefined };
}

const FALLBACK_FLOOR_MS = 1000;

async function attempt(
  provider: Provider,
  req: SuggestRequest,
  timeoutMs: number,
): Promise<ProviderAttempt & { suggestions: Suggestion[] }> {
  const started = Date.now();
  try {
    const suggestions = await withTimeout(provider, req, timeoutMs);
    return { id: provider.id, ms: Date.now() - started, count: suggestions.length, suggestions };
  } catch (e) {
    return { id: provider.id, ms: Date.now() - started, count: 0, error: describeError(e), suggestions: [] };
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'timed out' : e.message || e.name;
  return String(e);
}

// Races the signal as well as passing it: a provider that ignores abort still cannot hold the chip past the budget.
function withTimeout(provider: Provider, req: SuggestRequest, timeoutMs: number): Promise<Suggestion[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise<Suggestion[]>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    provider.suggest(req, { signal }).then(resolve, reject);
  });
}

/**
 * Fills must name an empty field and cite another tab's text; actions must
 * cite the page's own text; interactions must name a described element with
 * a verb that fits its role and state, cite another tab's text or a recent
 * fill, and never a destructive name. A button or link is clicked only after
 * carat filled something on the page. A scroll to an element that is already
 * on-screen becomes the verb it stood in for, or nothing.
 */
function valid(
  suggestions: Suggestion[],
  fields: FieldDescriptor[],
  elements: ElementDescriptor[],
  filled: string[],
  context: RequestContext,
  own: RequestContext,
): Suggestion[] {
  const contextIds = new Set(context.map((c) => c.id));
  const ownIds = new Set(own.map((o) => o.id));
  const interactIds = new Set([...contextIds, ...filled]);
  return suggestions.flatMap((raw): Suggestion[] => {
    const s = raw.kind === 'interact' ? settleScroll(raw, elements) : raw;
    if (!s || typeof s.value !== 'string' || s.confidence < LIMITS.minConfidence) return [];
    const bare = s.kind === 'interact' && s.verb === 'scroll';
    if (!bare && s.value.trim().length === 0) return [];
    if (s.kind === 'action') return isIntentName(s.intent) && ownIds.has(s.sourceContextId) ? [s] : [];
    if (s.kind === 'interact') {
      const el = elements.find((e) => e.i === s.elementId);
      if (!el || isDestructiveName(el.nm) || !interactIds.has(s.sourceContextId)) return [];
      if (!verbFits(el, s.verb, s.value.trim())) return [];
      return s.verb !== 'click' || (el.r !== 'button' && el.r !== 'link') || filled.length > 0 ? [s] : [];
    }
    const field = fields.find((f) => f.i === s.fieldId);
    return !!field && !field.v && contextIds.has(s.sourceContextId) ? [s] : []; // never over what the user typed, never from their own page
  });
}

/**
 * A `scroll` only means something for an element that is off-screen; carat
 * scrolls to an on-screen one's chip by itself. So a scroll to an on-screen
 * element is rewritten to the one verb the element implies (click a button,
 * check a box), which then faces the same checks as if the model had said
 * so, or dropped when the element needs a value (slider, select).
 */
function settleScroll(s: InteractSuggestion, elements: ElementDescriptor[]): InteractSuggestion | null {
  if (s.verb !== 'scroll') return s;
  const el = elements.find((e) => e.i === s.elementId);
  if (!el) return null;
  if (isOffScreen(el)) return s;
  const verb = impliedVerb(el);
  return verb ? { ...s, verb, value: el.nm } : null;
}

function isSuppressed(s: FillSuggestion, input: SuggestInput, keys: string[]): boolean {
  const field = input.fields.find((f) => f.i === s.fieldId);
  if (!field) return true;
  const prefix = suppressionPrefix(s.sourceContextId, input.page.host);
  return keys.some((k) => k.startsWith(prefix) && fingerprintMatchesDescriptor(k.slice(prefix.length), field));
}

function topPerField(suggestions: FillSuggestion[]): FillSuggestion[] {
  return topBy(suggestions, (s) => s.fieldId);
}

function topPerIntent(actions: ActionSuggestion[]): ActionSuggestion[] {
  return topBy(actions, (a) => a.intent);
}

function topPerElement(interactions: InteractSuggestion[]): InteractSuggestion[] {
  return topBy(interactions, (s) => s.elementId);
}

function topBy<T extends { confidence: number }>(list: T[], keyOf: (t: T) => string): T[] {
  const best = new Map<string, T>();
  for (const s of list) {
    const cur = best.get(keyOf(s));
    if (!cur || s.confidence > cur.confidence) best.set(keyOf(s), s);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

function cacheKey(input: SuggestInput, elements: ElementDescriptor[], filled: string[], context: RequestContext, own: RequestContext): string {
  // Focus, width and what is scrolled into view change as the user moves around without changing what to suggest.
  const fields = input.fields.map(({ f: _f, w: _w, o: _o, ...rest }) => rest);
  const els = elements.map(({ o: _o, ...rest }) => rest);
  const ids = [...context, ...own].map((c) => c.id).join(',');
  return fnv1a(`${input.page.host}|${JSON.stringify(fields)}|${JSON.stringify(els)}|${filled.join(',')}|${ids}`).toString(36);
}
