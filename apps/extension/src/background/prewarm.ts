import type { Eagerness, FieldDescriptor, FillSuggestion, KnownPage, KnownPageId, PageMeta, RequestContext, Settings, SuggestRequest, Suggestion } from '@carat/shared';
import { EAGERNESS, KNOWN_PAGES, LIMITS, fnv1a, knownPageFor, knownPageForUrl, matchesKnownField } from '@carat/shared';
import type { Provider } from '@carat/providers';
import { createProvider } from '@carat/providers';
import type { ContextStore } from '../store';
import type { GateVerdict, ProviderAttempt } from './diag';
import { explainGate } from './gate';
import type { Requester } from './requester';
import { scoreAndPickContext } from './score';

/**
 * What became of one top-frame navigation onto a known page. `warmed`: the
 * provider answered and the answer is in the 60s cache. `warm`: an answer for
 * this page and context was already there, or is on its way. `failed`: the
 * provider errored or timed out, nothing was cached. The rest are the gate's
 * own verdicts, `own-context` covering a tab whose only fresh text is its own.
 */
export type PrewarmVerdict = Exclude<GateVerdict, 'ok'> | 'warmed' | 'warm' | 'unknown-page' | 'no-context' | 'failed';

export interface PrewarmDiag {
  at: number;
  host: string;
  verdict: PrewarmVerdict;
  attempts?: ProviderAttempt[];
  /** Fills cached, once warmed. */
  count?: number;
}

/** The slice of chrome.webNavigation's event details the prewarmer reads. */
export interface CommitDetails {
  tabId: number;
  frameId: number;
  url: string;
}

export interface NavigationEvent {
  addListener(callback: (details: CommitDetails) => void): void;
}

/** chrome.webNavigation, or a fake. History updates catch a Calendar "Create" that never reloads the page. */
export interface WebNavigationApi {
  onCommitted: NavigationEvent;
  onHistoryStateUpdated?: NavigationEvent;
}

export interface PrewarmDeps {
  store: ContextStore;
  settings: () => Promise<Settings>;
  createProvider?: (settings: Settings) => Provider;
  now?: () => number;
  timeoutMs?: number;
  /** Told what became of each commit onto a known page, for the popup's debug line. Unknown pages are not reported. */
  onDiag?: (tabId: number, diag: PrewarmDiag) => void;
  /** The pages worth warming; the registry's four unless a test says otherwise. */
  pages?: readonly KnownPage[];
}

export interface Prewarmer {
  /** One top-frame navigation: decide, and if it is worth it, ask the provider and fill the cache. */
  handle(tabId: number, url: string): Promise<PrewarmVerdict>;
  attach(api: WebNavigationApi): void;
  /** Resolves once every navigation being handled right now has been decided and, if warmed, answered. */
  settled(): Promise<void>;
}

const PREWARM_PREFIX = 'prewarm|';

/**
 * The cache key a pre-warmed answer sits under. The orchestrator's own key
 * hashes the live fields and elements, which nobody knows before the DOM
 * exists, so the pre-warmed answer is filed by the page and the ids of the
 * other tabs' text it was answered from instead; `lookupPrewarmed` recomputes
 * it when the real snapshot arrives. The prefix keeps it clear of the
 * orchestrator's bare base-36 hashes.
 */
export function prewarmKey(page: KnownPageId, context: RequestContext): string {
  return `${PREWARM_PREFIX}${page}|${fnv1a(context.map((c) => c.id).join(',')).toString(36)}`;
}

/**
 * On a navigation onto Maps, Calendar, Gmail or Google search, run the same
 * provider call the content script's first request would trigger, using the
 * fields those pages are known to have, so the answer is in the 60s cache by
 * the time the page has a DOM. Nothing else is stored; a failed call leaves
 * the cache alone.
 */
export function createPrewarmer(deps: PrewarmDeps): Prewarmer {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? LIMITS.providerTimeoutMs;
  const pages = deps.pages ?? KNOWN_PAGES;
  const inflight = new Map<string, Promise<PrewarmVerdict>>();
  // Every navigation being decided or warmed, so `settled` covers the gate as well as the call.
  const pending = new Set<Promise<unknown>>();

  async function handle(tabId: number, url: string): Promise<PrewarmVerdict> {
    const known = knownPageForUrl(url, pages);
    if (!known) return 'unknown-page';
    const origin = new URL(url).origin;
    const requester: Requester = { tabId, origin };
    const note = (verdict: PrewarmVerdict, rest: Partial<PrewarmDiag> = {}): PrewarmVerdict => {
      deps.onDiag?.(tabId, { at: now(), host: known.page.host, verdict, ...rest });
      return verdict;
    };

    const settings = await deps.settings();
    const items = await deps.store.items();
    const at = await deps.store.clock();
    const gate = explainGate({ page: known.page, fields: known.fields }, settings);
    if (gate !== 'ok') return note(gate);
    // The gate lets everything with a snapshot through now, but a pre-warm has no page
    // to read a prior off yet: without another tab's text there is nothing to warm from.
    const context = scoreAndPickContext(items, requester, at, settings.eagerness);
    if (context.length === 0) return note('no-context');

    const key = prewarmKey(known.id, context);
    // The in-flight check comes after the last await so two commits deciding at once cannot both start a call.
    if ((await deps.store.getCached(key)) !== undefined || inflight.has(key)) return note('warm');
    const job = warm(known, context, settings, key, note).finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function warm(
    known: KnownPage,
    context: RequestContext,
    settings: Settings,
    key: string,
    note: (verdict: PrewarmVerdict, rest?: Partial<PrewarmDiag>) => PrewarmVerdict,
  ): Promise<PrewarmVerdict> {
    const req: SuggestRequest = {
      page: known.page,
      fields: known.fields,
      context,
      now: new Date(now()).toISOString(),
      ...(typeof navigator !== 'undefined' && navigator.language ? { locale: navigator.language } : {}),
    };
    const attempt = await ask(req, settings);
    if (attempt.error) return note('failed', { attempts: [attempt] });
    const fills = validFills(attempt.suggestions, known.fields, context, settings.eagerness);
    await deps.store.setCached(key, fills);
    return note('warmed', { attempts: [attempt], count: fills.length });
  }

  /** One attempt on the configured provider. No regex fallback: a fallback answer would only be cached, and only real answers are. */
  async function ask(req: SuggestRequest, settings: Settings): Promise<ProviderAttempt & { suggestions: Suggestion[] }> {
    const started = Date.now();
    let provider: Provider;
    try {
      provider = (deps.createProvider ?? createProvider)(settings);
    } catch (e) {
      return { id: settings.provider, ms: 0, count: 0, error: describeError(e), suggestions: [] };
    }
    try {
      const suggestions = await withTimeout(provider, req, timeoutMs);
      return { id: provider.id, ms: Date.now() - started, count: suggestions.length, suggestions };
    } catch (e) {
      return { id: provider.id, ms: Date.now() - started, count: 0, error: describeError(e), suggestions: [] };
    }
  }

  function attach(api: WebNavigationApi): void {
    const on = (d: CommitDetails): void => {
      if (d.frameId !== 0) return;
      const job = handle(d.tabId, d.url).catch(() => undefined);
      pending.add(job);
      void job.finally(() => pending.delete(job));
    };
    api.onCommitted.addListener(on);
    api.onHistoryStateUpdated?.addListener(on);
  }

  return {
    handle,
    attach,
    settled: () => Promise.all([...pending, ...inflight.values()]).then(() => undefined),
  };
}

/**
 * For the orchestrator: the pre-warmed fills for a live snapshot, with their
 * field ids rewritten onto the fields the content script described, or
 * undefined when this is not a known page, nothing was warmed for this page
 * and context, or no warmed field is on the page and still empty. `context`
 * must be the same `scoreAndPickContext` pick the real request will send.
 */
export async function lookupPrewarmed(
  store: Pick<ContextStore, 'getCached'>,
  page: PageMeta,
  fields: FieldDescriptor[],
  context: RequestContext,
): Promise<FillSuggestion[] | undefined> {
  const known = knownPageFor(page.host, page.path);
  if (!known || context.length === 0) return undefined;
  const cached = await store.getCached(prewarmKey(known.id, context));
  if (!cached) return undefined;
  const adopted = adoptFills(cached, known.fields, fields);
  return adopted.length > 0 ? adopted : undefined;
}

/** Rewrite each fill's field id from the known list onto the matching empty live field; fills with no live match are dropped. */
export function adoptFills(suggestions: Suggestion[], known: FieldDescriptor[], live: FieldDescriptor[]): FillSuggestion[] {
  const out: FillSuggestion[] = [];
  for (const s of suggestions) {
    if (s.kind !== 'fill') continue;
    const want = known.find((f) => f.i === s.fieldId);
    const target = want && live.find((f) => !f.v && matchesKnownField(want, f));
    if (target) out.push({ ...s, fieldId: target.i });
  }
  return out;
}

/** The orchestrator's fill rule: an empty known field, a real value, over the level's floor, citing another tab's text. */
function validFills(suggestions: Suggestion[], fields: FieldDescriptor[], context: RequestContext, eagerness: Eagerness): FillSuggestion[] {
  const ids = new Set(context.map((c) => c.id));
  const floor = EAGERNESS[eagerness].minConfidence;
  return suggestions.filter((s): s is FillSuggestion => {
    if (s.kind !== 'fill') return false;
    if (typeof s.value !== 'string' || s.value.trim().length === 0 || s.confidence < floor) return false;
    return fields.some((f) => f.i === s.fieldId && !f.v) && ids.has(s.sourceContextId);
  });
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'timed out' : e.message || e.name;
  return String(e);
}

// Races the signal as well as passing it, like the orchestrator: a provider that ignores abort still cannot run past the budget.
function withTimeout(provider: Provider, req: SuggestRequest, timeoutMs: number): Promise<Suggestion[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise<Suggestion[]>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    provider.suggest(req, { signal }).then(resolve, reject);
  });
}
