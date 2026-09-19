import type {
  ActionSuggestion,
  FieldDescriptor,
  FillSuggestion,
  PageMeta,
  RequestContext,
  Settings,
  SuggestRequest,
  Suggestion,
} from '@carat/shared';
import { LIMITS, fnv1a, isIntentName } from '@carat/shared';
import type { Provider } from '@carat/providers';
import { LocalProvider, createProvider } from '@carat/providers';
import type { SuggestResponse, SuggestionSource } from '../messaging';
import type { ContextStore } from '../store';
import { navSuppressionKey, suppressionPrefix } from '../store';
import type { ProviderAttempt, SuggestDiag } from './diag';
import { fingerprintMatchesDescriptor } from './fingerprint';
import { explainGate } from './gate';
import type { OpenTab } from './navigation';
import { resolveNavigation } from './navigation';
import type { Requester } from './requester';
import { ownContext, scoreAndPickContext } from './score';

export interface SuggestInput {
  page: PageMeta;
  fields: FieldDescriptor[];
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
}

const NONE: SuggestResponse = { suggestions: [], navigation: [] };

export async function orchestrate(input: SuggestInput, requester: Requester, deps: OrchestrateDeps): Promise<SuggestResponse> {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? LIMITS.providerTimeoutMs;
  const { store } = deps;
  const diag: SuggestDiag = { at: now(), host: input.page.host, fields: input.fields.length, gate: 'ok' };

  const settings = await deps.settings();
  const items = await store.items();
  // Freshness follows the store's clock, which stands still while pinned.
  const at = await store.clock();
  diag.gate = explainGate(input, items, settings, requester, at);
  if (diag.gate !== 'ok') {
    deps.onDiag?.(diag);
    return NONE;
  }

  const context = scoreAndPickContext(items, requester, at);
  const own = ownContext(items, requester, at);
  if (context.length === 0 && own.length === 0) {
    deps.onDiag?.(diag);
    return NONE;
  }

  const key = cacheKey(input, context, own);
  let suggestions = input.force ? undefined : await store.getCached(key);
  diag.cached = suggestions !== undefined;
  if (!suggestions) {
    const req: SuggestRequest = {
      page: input.page,
      fields: input.fields,
      context,
      ...(own.length > 0 ? { own } : {}),
      now: new Date(now()).toISOString(),
      ...(typeof navigator !== 'undefined' && navigator.language ? { locale: navigator.language } : {}),
    };
    const outcome = await callProvider(req, settings, deps, timeoutMs);
    diag.attempts = outcome.attempts;
    suggestions = valid(outcome.suggestions, input.fields, context, own);
    // A transport error or timeout is not "nothing to suggest": caching it
    // would hide chips for a minute after one blip. Only a real answer is kept.
    if (!outcome.failed) await store.setCached(key, suggestions);
  }

  const suppressed = input.force ? [] : await store.suppressedKeys();
  const fills = suggestions.filter(isFill).filter((s) => !isSuppressed(s, input, suppressed));
  const actions = suggestions.filter(isAction).filter((a) => !suppressed.includes(navSuppressionKey(a.intent, a.value)));
  const tabs = actions.length > 0 ? await (deps.tabs ?? noTabs)().catch(() => []) : [];
  const sources = new Map([...context, ...own].map((c) => [c.id, sourceOf(c)] as const));
  const withSource = <T extends { sourceContextId: string }>(s: T): T & { source?: SuggestionSource } => ({
    ...s,
    ...(sources.has(s.sourceContextId) ? { source: sources.get(s.sourceContextId) } : {}),
  });
  const offered = topPerField(fills).slice(0, LIMITS.maxSuggestions).map(withSource);
  const navigation = resolveNavigation(topPerIntent(actions), tabs, requester, input.page)
    .slice(0, LIMITS.maxNavigations)
    .map(withSource);
  diag.offered = offered.length;
  diag.navigation = navigation.length;
  deps.onDiag?.(diag);
  return { suggestions: offered, navigation };
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

/** Fills must name an empty field and cite another tab's text; actions must cite the page's own text. */
function valid(suggestions: Suggestion[], fields: FieldDescriptor[], context: RequestContext, own: RequestContext): Suggestion[] {
  const contextIds = new Set(context.map((c) => c.id));
  const ownIds = new Set(own.map((o) => o.id));
  return suggestions.filter((s) => {
    if (typeof s.value !== 'string' || s.value.trim().length === 0 || s.confidence < LIMITS.minConfidence) return false;
    if (s.kind === 'action') return isIntentName(s.intent) && ownIds.has(s.sourceContextId);
    const field = fields.find((f) => f.i === s.fieldId);
    return !!field && !field.v && contextIds.has(s.sourceContextId); // never over what the user typed, never from their own page
  });
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

function topBy<T extends { confidence: number }>(list: T[], keyOf: (t: T) => string): T[] {
  const best = new Map<string, T>();
  for (const s of list) {
    const cur = best.get(keyOf(s));
    if (!cur || s.confidence > cur.confidence) best.set(keyOf(s), s);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

function cacheKey(input: SuggestInput, context: RequestContext, own: RequestContext): string {
  // Focus and width change as the user moves around without changing what to suggest.
  const fields = input.fields.map(({ f: _f, w: _w, ...rest }) => rest);
  const ids = [...context, ...own].map((c) => c.id).join(',');
  return fnv1a(`${input.page.host}|${JSON.stringify(fields)}|${ids}`).toString(36);
}
