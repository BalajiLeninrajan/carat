import type { NextAction, NextActionRequest, OpenTab, OutlineControl, Settings } from '@carat/shared';
import {
  EAGERNESS,
  INTENT_REGISTRY,
  LIMITS,
  fnv1a,
  isIntentDestination,
  isIrreversibleLabel,
  normalizeWhitespace,
  resolveIntentValue,
  scrollLabel,
  truncate,
} from '@carat/shared';
import type { Provider } from '@carat/providers';
import { LocalProvider, RaceProvider, cacheKey as promptCacheKey, createProvider } from '@carat/providers';
import type { StorageArea } from '../store';
import type { NextActionResponse, PageSnapshot } from '../messaging';
import { AnswerCache, CACHE_MS } from './answer-cache';
import type { DebugAnswer, DebugRequest } from './debug';
import type { AnswerOrigin, GateVerdict, SuggestDiag } from './diag';
import { explainGate } from './gate';
import type { HistoryStore } from './history';
import { lastResort } from './last-resort';

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
  /** One line for what the user is trying to get done across tabs, when carat has worked one out. */
  goal?: () => Promise<string | undefined>;
  /** The user's open tabs, so `switch` has something to name. */
  tabs?: () => Promise<OpenTab[]>;
  /** Where the model's later answer goes. Without it the reply waits for the model. */
  refine?: RefineQueue;
  /** Whether this tab's prefix was already sent to the provider on navigation; for the diag line only. */
  warmed?: (tabId: number | undefined, req: NextActionRequest) => boolean;
  now?: () => number;
  timeoutMs?: number;
  onDiag?: (diag: SuggestDiag) => void;
  /**
   * Set only while a tab's debug panel is open: the request exactly as it went
   * out, then the answer with the raw reply, the race's winner and the
   * validator's verdict on each pass. Nothing extra is assembled without it.
   */
  onDebug?: (patch: { request?: DebugRequest; answer?: DebugAnswer }) => void;
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
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.evidenceReason ? { evidenceReason: input.evidenceReason } : {}),
  };
  if (diag.gate !== 'ok') {
    diag.silent = SILENT_GATE[diag.gate];
    deps.onDiag?.(diag);
    return { action: null };
  }

  const [history, notes, tabs, goal] = await Promise.all([
    requester.tabId === undefined ? [] : (deps.history?.lines(requester.tabId, started) ?? []),
    deps.notes?.lines(input.page.host) ?? [],
    deps.tabs?.().catch(() => []) ?? [],
    deps.goal?.().catch(() => undefined) ?? undefined,
  ]);
  const req: NextActionRequest = {
    page: input.page,
    outline: input.outline,
    controls: input.controls,
    ...(input.focused !== undefined ? { focused: input.focused } : {}),
    history,
    notes,
    ...(goal ? { goal } : {}),
    tabs: tabs.filter((t: OpenTab) => t.id !== requester.tabId),
    now: new Date(started).toISOString(),
    eagerness: settings.eagerness,
  };

  const key = cacheKeyFor(req);
  // Only ever set while the tab's debug panel is open; without it nothing
  // beyond the ordinary diag line is assembled or kept.
  const watching = deps.onDebug;
  const validations: string[] | undefined = watching ? [] : undefined;
  let raw: string | undefined;
  watching?.({ request: { at: started, req, cacheKey: key, promptCacheKey: promptCacheKey(req.page.host, req.page.path) } });
  const trace = (placeholder: NextAction | null, chosen: NextAction | null, provider?: Provider): void => {
    watching?.({
      answer: {
        at: now(),
        placeholder,
        action: chosen,
        ...(raw !== undefined ? { raw } : {}),
        ...(provider instanceof RaceProvider && provider.winner ? { winner: provider.winner } : {}),
        attempts: [...(diag.attempts ?? [])],
        validations: [...(validations ?? [])],
      },
    });
  };

  const hit = input.force ? undefined : await cache.get(key);
  if (hit && started - hit.at < CACHE_MS) {
    diag.source = 'cache';
    diag.ms = now() - started;
    report(diag, hit.action);
    sayWhySilent(diag, hit.action);
    deps.onDiag?.(diag);
    trace(null, hit.action);
    return { action: hit.action };
  }

  diag.warmed = deps.warmed?.(requester.tabId, req) ?? false;
  // No network behind it, so this is the first tick: the chip is up while the model is still reading.
  const placeholder = enrich(
    checked('placeholder', await answer(deps.localProvider ?? new LocalProvider(), req, deps), req, settings, diag, validations),
    req,
  );
  diag.placeholderMs = now() - started;
  const provider = (deps.createProvider ?? ((s: Settings) => createProvider(s)))(settings);
  // With no ticket there is nowhere to put a later answer, so the reply waits for the model itself.
  const keepRaw = watching ? (text: string) => (raw = text) : undefined;
  if (!deps.refine) {
    const model = checked(
      'model',
      await answer(
        provider,
        req,
        deps,
        () => {
          diag.partialMs ??= now() - started;
        },
        keepRaw,
      ),
      req,
      settings,
      diag,
      validations,
    );
    diag.finalMs = now() - started;
    const first = pick(placeholder, model);
    diag.source = first === placeholder && placeholder !== null ? 'placeholder' : 'model';
    if (provider instanceof RaceProvider) diag.attempts = [...provider.attempts];
    // Eager owes the user a chip: nothing here is an answer, it is a reason to ask again.
    const chosen = enrich(await insist(first, provider, req, settings, deps, diag, validations), req);
    diag.ms = now() - started;
    void cache.set(key, { at: started, action: chosen });
    report(diag, chosen);
    sayWhySilent(diag, chosen);
    deps.onDiag?.(diag);
    trace(placeholder, chosen, provider);
    return { action: chosen };
  }

  const ticket = deps.refine.open(requester.tabId);
  diag.source = placeholder ? 'placeholder' : 'model';
  diag.ms = now() - started;
  diag.refine = true;
  report(diag, placeholder);
  deps.onDiag?.(diag);

  void (async () => {
    let settled: NextAction | null = placeholder;
    try {
      const model = checked(
        'model',
        await answer(
          provider,
          req,
          deps,
          (target) => {
            // The ring moves to the control the model named before it has finished naming what to do there.
            diag.partialMs ??= now() - started;
            if (req.controls.some((c) => c.n === target)) ticket.push({ target });
          },
          keepRaw,
        ),
        req,
        settings,
        diag,
        validations,
      );
      diag.finalMs = now() - started;
      if (provider instanceof RaceProvider) diag.attempts = [...provider.attempts];
      // Eager owes the user a chip: nothing here is a reason to ask again, not an answer.
      const chosen = enrich(await insist(pick(placeholder, model), provider, req, settings, deps, diag, validations), req);
      settled = chosen;
      void cache.set(key, { at: now(), action: chosen });
      if (chosen !== placeholder) {
        diag.replaced = true;
        if (diag.source !== 'fallback') diag.source = 'model';
        report(diag, chosen);
        ticket.push({ action: chosen });
      }
      sayWhySilent(diag, chosen ?? placeholder);
    } catch {
      // Nothing the model or the page could offer. The chip keeps the placeholder, if there was one.
      sayWhySilent(diag, placeholder);
    } finally {
      ticket.close();
      deps.onDiag?.(diag);
      trace(placeholder, settled, provider);
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
  onRaw?: (text: string) => void,
): Promise<NextAction | null> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? LIMITS.providerTimeoutMs);
  try {
    return await provider.next(req, {
      signal,
      ...(onTarget ? { onPartial: ({ target }: { target: number | null }) => target !== null && onTarget(target) } : {}),
      ...(onRaw ? { onRaw } : {}),
    });
  } catch {
    return null;
  }
}

/**
 * `validate`, with a line written for the debug panel saying what the
 * validator made of this pass. Without a panel open `lines` is undefined and
 * this is `validate` and nothing else.
 */
function checked(
  who: string,
  action: NextAction | null,
  req: NextActionRequest,
  settings: Settings,
  diag: SuggestDiag,
  lines: string[] | undefined,
): NextAction | null {
  const had = diag.refused;
  const out = validate(action, req, settings, diag);
  if (lines) {
    if (out) lines.push(`${who}: allowed`);
    else if (diag.refused && diag.refused !== had) lines.push(`${who}: refused, ${diag.refused}`);
    else lines.push(`${who}: nothing to allow`);
  }
  return out;
}

/**
 * The line the re-ask puts in the timeline so the model reads why it is being
 * asked twice. It goes in `<history>` like any other line: the model is told
 * what happened, not scolded in an instruction it has already seen.
 */
export function nudgeLine(why: string): string {
  return `carat: the last answer was ${why}; something on this page is still the next step`;
}

/**
 * Why a request that never reached a provider ended with no chip, in plain
 * words. The same wording the popup's gate line uses, so the two never
 * disagree in front of the user.
 */
const SILENT_GATE: Record<Exclude<GateVerdict, 'ok'>, string> = {
  disabled: 'carat is off',
  'site-off': 'carat is off for this site',
  denylisted: 'host is on the denylist',
  password: 'the page has a password field',
  'no-snapshot': 'nothing on the page to act on',
};

/**
 * At `eager` there is no "nothing". A first answer of none — the model's own
 * `none`, an answer the validator refused, one under the floor, a provider
 * that failed or timed out, a race in which everything came back empty — is
 * put back to the model once, with the reason written into the timeline it
 * reads. If that answers nothing too, the plainest step the page itself
 * offers stands in. At the quieter levels nothing is nothing, and this
 * returns it unchanged.
 */
async function insist(
  chosen: NextAction | null,
  provider: Provider,
  req: NextActionRequest,
  settings: Settings,
  deps: NextActionDeps,
  diag: SuggestDiag,
  lines?: string[],
): Promise<NextAction | null> {
  if (chosen || settings.eagerness !== 'eager') return chosen;
  const why = diag.refused ?? 'none';
  diag.reasked = why;
  delete diag.refused;
  lines?.push(`asked again after "${why}"`);
  const again: NextActionRequest = { ...req, history: [...req.history, nudgeLine(why)] };
  const second = checked('second ask', await answer(provider, again, deps), again, settings, diag, lines);
  // A race keeps only its latest run's attempts, and this was a run of its own.
  if (provider instanceof RaceProvider) diag.attempts = [...(diag.attempts ?? []), ...provider.attempts];
  if (second) return second;
  const fallback = checked('the page’s plainest step', lastResort(req), req, settings, diag, lines);
  if (fallback) {
    diag.source = 'fallback';
    delete diag.refused;
  }
  return fallback;
}

/** Records why there is no chip, and clears the note when there is one. */
function sayWhySilent(diag: SuggestDiag, action: NextAction | null): void {
  if (action) {
    delete diag.silent;
    return;
  }
  diag.silent = diag.refused
    ? `the answer was refused: ${diag.refused}`
    : diag.eagerness === 'eager'
      ? 'nothing was offered and the page had no plainer step to stand in'
      : 'nothing reached this level’s floor';
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

/** How long the line under a chip may run before it is clipped. */
export const SOURCE_CHARS = 80;

/**
 * What the chip's hover preview needs and the model was never asked for:
 * where a fill's value was read, and where an `open` or a `switch` lands. All
 * of it is already in the request the worker assembled, so it costs nothing;
 * the model's own `reason` is left alone, because that is the tooltip.
 */
export function enrich(action: NextAction | null, req: NextActionRequest): NextAction | null {
  if (!action) return null;
  // The placeholder is enriched once and may come back through here as the
  // chosen answer. Same object out, or the refine path would read it as the
  // model having replaced itself.
  if (action.source !== undefined || action.destination !== undefined) return action;
  if (action.kind === 'fill' || action.kind === 'select') {
    const source = sourceOf(action.value, req);
    return source ? { ...action, source } : action;
  }
  if (action.kind === 'open') {
    const destination = openDestination(action.value, req.tabs);
    return destination ? { ...action, destination } : action;
  }
  if (action.kind === 'switch') {
    const tab = req.tabs.find((t) => String(t.id) === action.value);
    return tab ? { ...action, destination: { host: tab.host, title: tab.title } } : action;
  }
  return action;
}

/**
 * The note or timeline line the value came from, worded for one line under
 * the chip. A note wins over the timeline: "from discord.com: dinner at Seven
 * Shores Cafe, Friday at 6?" says more than "from this tab: 40s ago: typed…".
 * A value of one or two characters matches too much to be evidence of
 * anything, so it is left without a source.
 */
function sourceOf(value: string, req: NextActionRequest): string | undefined {
  const needle = normalizeWhitespace(value).toLowerCase();
  if (needle.length < 3) return undefined;
  const note = req.notes.find((n) => normalizeWhitespace(n).toLowerCase().includes(needle));
  if (note) return truncate(`from ${noteOrigin(note)}: ${noteFact(note)}`, SOURCE_CHARS);
  const line = req.history.find((h) => normalizeWhitespace(h).toLowerCase().includes(needle));
  return line ? truncate(`from this tab: ${normalizeWhitespace(line)}`, SOURCE_CHARS) : undefined;
}

/** What a note renders as: the fact, then `(read on discord.com, 2m ago)`. */
const NOTE_TAIL = /\s*\((?:read on ([^,()]+)|this tab), [^()]*\)\s*$/;

function noteFact(note: string): string {
  return normalizeWhitespace(note.replace(NOTE_TAIL, ''));
}

function noteOrigin(note: string): string {
  return NOTE_TAIL.exec(note)?.[1]?.trim() ?? 'this tab';
}

/**
 * Where an `open` would land. A tab already showing that destination names it
 * better than the built URL does, so it is preferred; otherwise the host the
 * registry built and what it would look up.
 */
function openDestination(value: string, tabs: OpenTab[]): { host: string; title?: string } | undefined {
  const resolved = resolveIntentValue(value);
  if (!resolved) return undefined;
  let host: string;
  try {
    host = new URL(resolved.url).host;
  } catch {
    return undefined;
  }
  const open = tabs.find((t) => isIntentDestination(resolved.intent, `https://${t.host}/`));
  return { host: open?.host ?? host, title: open?.title || `${INTENT_REGISTRY[resolved.intent].site}: ${resolved.entity.value}` };
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
