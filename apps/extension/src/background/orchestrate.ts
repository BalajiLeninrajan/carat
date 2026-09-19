import type { FieldDescriptor, PageMeta, Settings, SuggestRequest, Suggestion } from '@carat/shared';
import { LIMITS, fnv1a } from '@carat/shared';
import type { Provider } from '@carat/providers';
import { LocalProvider, createProvider } from '@carat/providers';
import type { ContextStore } from '../store';
import { suppressionPrefix } from '../store';
import { fingerprintMatchesDescriptor } from './fingerprint';
import { gate } from './gate';
import type { Requester } from './requester';
import { scoreAndPickContext } from './score';

export interface SuggestInput {
  page: PageMeta;
  fields: FieldDescriptor[];
}

export interface OrchestrateDeps {
  store: ContextStore;
  settings: () => Promise<Settings>;
  createProvider?: (settings: Settings) => Provider;
  localProvider?: Provider;
  now?: () => number;
  timeoutMs?: number;
}

const NONE: { suggestions: Suggestion[] } = { suggestions: [] };

export async function orchestrate(
  input: SuggestInput,
  requester: Requester,
  deps: OrchestrateDeps,
): Promise<{ suggestions: Suggestion[] }> {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? LIMITS.providerTimeoutMs;
  const { store } = deps;

  const settings = await deps.settings();
  const items = await store.items();
  if (!gate(input, items, settings, requester, now())) return NONE;

  const context = scoreAndPickContext(items, requester, now());
  if (context.length === 0) return NONE;

  const key = cacheKey(input, context);
  let suggestions = await store.getCached(key);
  if (!suggestions) {
    const req: SuggestRequest = {
      page: input.page,
      fields: input.fields,
      context,
      now: new Date(now()).toISOString(),
      ...(typeof navigator !== 'undefined' && navigator.language ? { locale: navigator.language } : {}),
    };
    suggestions = valid(await callProvider(req, settings, deps, timeoutMs), input.fields);
    await store.setCached(key, suggestions);
  }

  const suppressed = await store.suppressedKeys();
  const visible = suggestions.filter((s) => !isSuppressed(s, input, suppressed));
  return { suggestions: topPerField(visible).slice(0, LIMITS.maxSuggestions) };
}

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
): Promise<Suggestion[]> {
  const local = deps.localProvider ?? new LocalProvider();
  const deadline = Date.now() + timeoutMs;
  const floor = Math.min(FALLBACK_FLOOR_MS, timeoutMs);

  let provider: Provider;
  try {
    provider = (deps.createProvider ?? createProvider)(settings);
  } catch {
    provider = local;
  }

  try {
    const result = await withTimeout(provider, req, timeoutMs);
    if (result.length > 0 || provider.id === 'local' || settings.apiKey) return result;
  } catch {
    if (provider.id === 'local') return [];
  }
  try {
    return await withTimeout(local, req, Math.max(floor, deadline - Date.now()));
  } catch {
    return [];
  }
}

const FALLBACK_FLOOR_MS = 1000;

// Races the signal as well as passing it: a provider that ignores abort still cannot hold the chip past the budget.
function withTimeout(provider: Provider, req: SuggestRequest, timeoutMs: number): Promise<Suggestion[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise<Suggestion[]>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    provider.suggest(req, { signal }).then(resolve, reject);
  });
}

function valid(suggestions: Suggestion[], fields: FieldDescriptor[]): Suggestion[] {
  return suggestions.filter((s) => {
    const field = fields.find((f) => f.i === s.fieldId);
    return (
      !!field &&
      !field.v && // never over what the user typed
      typeof s.value === 'string' &&
      s.value.trim().length > 0 &&
      s.confidence >= LIMITS.minConfidence
    );
  });
}

function isSuppressed(s: Suggestion, input: SuggestInput, keys: string[]): boolean {
  const field = input.fields.find((f) => f.i === s.fieldId);
  if (!field) return true;
  const prefix = suppressionPrefix(s.sourceContextId, input.page.host);
  return keys.some((k) => k.startsWith(prefix) && fingerprintMatchesDescriptor(k.slice(prefix.length), field));
}

function topPerField(suggestions: Suggestion[]): Suggestion[] {
  const best = new Map<string, Suggestion>();
  for (const s of suggestions) {
    const cur = best.get(s.fieldId);
    if (!cur || s.confidence > cur.confidence) best.set(s.fieldId, s);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

function cacheKey(input: SuggestInput, context: SuggestRequest['context']): string {
  // Focus and width change as the user moves around without changing what to suggest.
  const fields = input.fields.map(({ f: _f, w: _w, ...rest }) => rest);
  const ids = context.map((c) => c.id).join(',');
  return fnv1a(`${input.page.host}|${JSON.stringify(fields)}|${ids}`).toString(36);
}
