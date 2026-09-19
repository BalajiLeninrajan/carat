import type { NextAction, NextActionRequest, OpenTab, OutlineControl, Settings } from '@carat/shared';
import {
  EAGERNESS,
  LIMITS,
  fnv1a,
  isIrreversibleLabel,
  normalizeWhitespace,
  resolveIntentValue,
  scrollLabel,
} from '@carat/shared';
import type { Provider } from '@carat/providers';
import { LocalProvider, RaceProvider, createProvider } from '@carat/providers';
import type { StorageArea } from '../store';
import type { NextActionResponse, PageSnapshot } from '../messaging';
import { AnswerCache, CACHE_MS } from './answer-cache';
import type { AnswerOrigin, SuggestDiag } from './diag';
import { explainGate } from './gate';
import type { HistoryStore } from './history';

import type { RefineQueue } from './refine';
import type { Requester } from './requester';

export interface NextActionDeps {
  settings: () => Promise<Settings>;
  createProvider?: (settings: Settings) => Provider;
  /** The instant answer. Defaults to the regex placeholder. */
  localProvider?: Provider;
  /** The per-tab timeline: read for the request, written when a chip is accepted or dismissed. */
  history?: Pick<HistoryStore, 'lines'>;
  /** Facts distilled from pages read in other tabs, newest first. */
  notes?: { lines(host: string): Promise<string[]> };
  /** The user's open tabs, so `switch` has something to name. */
  tabs?: () => Promise<OpenTab[]>;
  /** Where the model's later answer goes. Without it the reply waits for the model. */
  refine?: RefineQueue;
  /** Whether this tab's prefix was already sent to the provider on navigation; for the diag line only. */
  warmed?: (tabId: number | undefined, req: NextActionRequest) => boolean;
  now?: () => number;
  timeoutMs?: number;
  onDiag?: (diag: SuggestDiag) => void;
}

export { CACHE_MS };

/**
 * One cache for the worker, mirrored into `chrome.storage.session` once the
 * worker attaches an area to it, so an answer already paid for outlives the
 * worker that asked for it.
 */
const cache = new AnswerCache();

/** Called once at worker start; without it the cache is memory only. */
export function useAnswerStorage(area: StorageArea): void {
  cache.attach(area);
}

/**
 * One action per page: what the user is most likely to do next, and nothing
 * else. The placeholder answers in the first tick so a chip is up while the
 * model is still writing; the model's answer replaces it through the ticket
 * unless the placeholder was a fill backed by something the user read and the
 * model is less sure. Everything the engine refuses is refused for safety, not
 * taste: a control that is not on the page, a field filled with its own name,
 * a scroll with nothing below, an `open` the intent registry cannot build and
 * a `switch` to a tab that is not open.
 */
export async function nextAction(input: PageSnapshot, requester: Requester, deps: NextActionDeps): Promise<NextActionResponse> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const settings = await deps.settings();
  const diag: SuggestDiag = {
    at: started,
    host: input.page.host,
    controls: input.controls.length,
    gate: explainGate(input, settings),
    eagerness: settings.eagerness,
  };
  if (diag.gate !== 'ok') {
    deps.onDiag?.(diag);
    return { action: null };
  }

  const [history, notes, tabs] = await Promise.all([
    requester.tabId === undefined ? [] : (deps.history?.lines(requester.tabId, started) ?? []),
    deps.notes?.lines(input.page.host) ?? [],
    deps.tabs?.().catch(() => []) ?? [],
  ]);
  const req: NextActionRequest = {
    page: input.page,
    outline: input.outline,
    controls: input.controls,
    ...(input.focused !== undefined ? { focused: input.focused } : {}),
    history,
    notes,
    tabs: tabs.filter((t: OpenTab) => t.id !== requester.tabId),
    now: new Date(started).toISOString(),
    eagerness: settings.eagerness,
  };

  const key = cacheKeyFor(req);
  const hit = input.force ? undefined : await cache.get(key);
  if (hit && started - hit.at < CACHE_MS) {
    diag.source = 'cache';
    diag.ms = now() - started;
    report(diag, hit.action);
    deps.onDiag?.(diag);
    return { action: hit.action };
  }

  diag.warmed = deps.warmed?.(requester.tabId, req) ?? false;
  // No network behind it, so this is the first tick: the chip is up while the model is still reading.
  const placeholder = validate(await answer(deps.localProvider ?? new LocalProvider(), req, deps), req, settings, diag);
  diag.placeholderMs = now() - started;
  const provider = (deps.createProvider ?? ((s: Settings) => createProvider(s)))(settings);
  // With no ticket there is nowhere to put a later answer, so the reply waits for the model itself.
  if (!deps.refine) {
    const model = validate(
      await answer(provider, req, deps, () => {
        diag.partialMs ??= now() - started;
      }),
      req,
      settings,
      diag,
    );
    diag.finalMs = now() - started;
    const chosen = pick(placeholder, model);
    diag.source = chosen === placeholder && placeholder !== null ? 'placeholder' : 'model';
    diag.ms = now() - started;
    if (provider instanceof RaceProvider) diag.attempts = [...provider.attempts];
    void cache.set(key, { at: started, action: chosen });
    report(diag, chosen);
    deps.onDiag?.(diag);
    return { action: chosen };
  }

  const ticket = deps.refine.open(requester.tabId);
  diag.source = placeholder ? 'placeholder' : 'model';
  diag.ms = now() - started;
  diag.refine = true;
  report(diag, placeholder);
  deps.onDiag?.(diag);

  void (async () => {
    try {
      const model = validate(
        await answer(provider, req, deps, (target) => {
          // The ring moves to the control the model named before it has finished naming what to do there.
          diag.partialMs ??= now() - started;
          if (req.controls.some((c) => c.n === target)) ticket.push({ target });
        }),
        req,
        settings,
        diag,
      );
      diag.finalMs = now() - started;
      const chosen = pick(placeholder, model);
      void cache.set(key, { at: now(), action: chosen });
      if (provider instanceof RaceProvider) diag.attempts = [...provider.attempts];
      if (chosen !== placeholder) {
        diag.replaced = true;
        diag.source = 'model';
        report(diag, chosen);
        ticket.push({ action: chosen });
      }
    } catch {
      // A provider that never answered leaves the placeholder alone and caches nothing.
    } finally {
      ticket.close();
      deps.onDiag?.(diag);
    }
  })();

  return { action: placeholder, ticket: ticket.id };
}

/** Forget every cached answer: the shortcut, a settings change, a clear. */
export function clearActionCache(): void {
  cache.clear();
}

/** Resolves once the cache's writes have reached storage; for the tests. */
export function answerCacheFlushed(): Promise<void> {
  return cache.flush();
}

/** A page is the same question while its outline and the length of its history hold still. */
export function cacheKeyFor(req: NextActionRequest): string {
  return [req.page.host, req.page.path, fnv1a(req.outline).toString(36), req.history.length, req.eagerness].join('|');
}

async function answer(
  provider: Provider,
  req: NextActionRequest,
  deps: NextActionDeps,
  onTarget?: (target: number) => void,
): Promise<NextAction | null> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? LIMITS.providerTimeoutMs);
  try {
    return await provider.next(req, {
      signal,
      ...(onTarget ? { onPartial: ({ target }: { target: number | null }) => target !== null && onTarget(target) } : {}),
    });
  } catch {
    return null;
  }
}

/**
 * The model wins, except against a placeholder that had something the user
 * actually read and is surer of it. Anything beats nothing.
 */
export function pick(placeholder: NextAction | null, model: NextAction | null): NextAction | null {
  if (!model) return placeholder;
  if (!placeholder) return model;
  if (placeholder.kind === 'fill' && placeholder.confidence > model.confidence) return placeholder;
  return model;
}

/**
 * Safety only. The model decides what the next step is; this decides whether
 * carat is allowed to carry it out.
 */
export function validate(action: NextAction | null, req: NextActionRequest, settings: Settings, diag?: SuggestDiag): NextAction | null {
  const refuse = (why: string): null => {
    if (diag) diag.refused = why;
    return null;
  };
  if (!action || action.kind === 'none') return null;
  if (action.confidence < EAGERNESS[req.eagerness].minConfidence) return refuse('under the floor');

  const control = action.target === null ? undefined : req.controls.find((c) => c.n === action.target);
  if (['fill', 'click', 'select'].includes(action.kind)) {
    if (!control) return refuse('no such control on the page');
    if (/\bdisabled\b/.test(control.state ?? '')) return refuse('the control is disabled');
  }

  // Paying, sending, deleting: flagged, never refused. The chip asks for a second Tab.
  const irreversible = action.irreversible || control?.risky === true || isIrreversibleLabel(action.label);

  switch (action.kind) {
    case 'fill': {
      if (action.value === '') return refuse('a fill needs a value');
      if (echoes(action.value, control!)) return refuse("that is the field's own name");
      break;
    }
    case 'select':
      if (action.value === '') return refuse('a select needs an option');
      break;
    case 'scroll':
      if (!req.page.scroll.more) return refuse('nothing below the fold');
      break;
    case 'open':
      if (!resolveIntentValue(action.value)) return refuse('not a destination carat can build');
      break;
    case 'switch':
      if (!req.tabs.some((t) => String(t.id) === action.value)) return refuse('no such tab is open');
      break;
    case 'click':
      break;
  }
  return { ...action, target: control?.n ?? null, irreversible, label: action.label || fallbackLabel(action, control, req) };
}

function echoes(value: string, control: OutlineControl): boolean {
  const v = normalizeWhitespace(value).toLowerCase();
  return [control.name, control.value].some((t) => t && normalizeWhitespace(t).toLowerCase() === v);
}

function fallbackLabel(action: NextAction, control: OutlineControl | undefined, req: NextActionRequest): string {
  if (action.kind === 'scroll') return scrollLabel(req.page.scroll);
  if (!control) return 'Go';
  if (action.kind === 'fill') return `Fill ${control.name} with "${action.value}"`;
  if (action.kind === 'select') return `Set ${control.name} to "${action.value}"`;
  return `Click "${control.name}"`;
}

function report(diag: SuggestDiag, action: NextAction | null): void {
  if (!action) {
    delete diag.kind;
    delete diag.label;
    return;
  }
  diag.kind = action.kind;
  diag.label = action.label;
  diag.reason = action.reason;
  diag.confidence = action.confidence;
  diag.irreversible = action.irreversible;
}

/** What the answer's origin was, for the popup's line. */
export type { AnswerOrigin };
