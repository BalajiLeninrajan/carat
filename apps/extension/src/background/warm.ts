import type { NextActionRequest, OpenTab, Settings } from '@carat/shared';
import { WARMUP_OUTLINE, fnv1a, isDenylisted, renderPrefix } from '@carat/shared';
import type { Provider } from '@carat/providers';
import { RaceProvider, createProvider } from '@carat/providers';
import { isSiteOff } from '../store';
import type { StorageArea } from '../store/storage-area';
import type { CommittedDetails, NavigationEvents } from './history';
import { HISTORY_KEY } from './history';
import { NOTES_KEY } from './notes';

export const WARM_LIMITS = {
  /** A warm-up is a bet on the next second or two; past this it is only spending tokens. */
  abortMs: 3000,
  /** One per tab per half minute: a redirect chain is one navigation as far as the user is concerned. */
  perTabMs: 30_000,
  /** How long a warmed prefix is taken to still be in the provider's cache. */
  freshWarmMs: 30_000,
  /** Notes and history older than this are not worth keeping the worker up for. */
  materialMs: 30 * 60_000,
} as const;

export interface WarmDeps {
  settings: () => Promise<Settings>;
  /** The same notes the real request will carry. */
  notes: (tabId: number) => Promise<string[]>;
  /** The same timeline the real request will carry. */
  history: (tabId: number, now: number) => Promise<string[]>;
  /** The same open tabs, this one excluded. */
  tabs?: (tabId: number) => Promise<OpenTab[]>;
  /** The same goal, which sits at the head of the prefix; without it the warmed bytes are the wrong ones. */
  goal?: () => Promise<string | undefined>;
  createProvider?: (settings: Settings) => Provider;
  now?: () => number;
  abortMs?: number;
  perTabMs?: number;
  /** Told about every warm-up that was actually sent; the tests watch this. */
  onWarm?: (tabId: number, host: string) => void;
}

export interface Warmer {
  /** A top-frame commit: the page is coming, so put its prefix in front of the model now. */
  onCommitted(details: CommittedDetails): Promise<void>;
  /** One line of wiring in the service worker. */
  attach(navigation: NavigationEvents): void;
  /**
   * Whether the prefix this request is about to send was already warmed on
   * this tab. Compares the prefix itself, not just the tab: a note that
   * landed in between makes the warmed bytes the wrong ones.
   */
  warmed(tabId: number | undefined, req: Pick<NextActionRequest, 'goal' | 'notes' | 'history' | 'tabs'>, at?: number): boolean;
  forget(tabId: number): void;
}

interface Sent {
  at: number;
  prefix: number;
}

/**
 * The model is asked the same thing on every page: the instructions, the
 * few-shots, the notes, the timeline and the open tabs, and only then the
 * outline. All of that is known the moment Chrome commits a navigation,
 * seconds before the content script has an outline to send. So it is sent
 * then, with a placeholder where the outline goes and room for one token of
 * answer: the server reads the prefix, caches it under the page's key, and
 * the real request pays for the outline alone.
 *
 * Fire and forget in every direction. Nothing waits on it, a failure is never
 * raised, it is aborted after three seconds, and it happens at most once per
 * tab per thirty seconds so a redirect chain cannot turn into four calls. A
 * page with neither notes nor history behind it is not warmed at all: there
 * would be nothing in the prefix worth caching.
 */
export function createWarmer(deps: WarmDeps): Warmer {
  const now = deps.now ?? (() => Date.now());
  const abortMs = deps.abortMs ?? WARM_LIMITS.abortMs;
  const perTabMs = deps.perTabMs ?? WARM_LIMITS.perTabMs;
  const sent = new Map<number, Sent>();
  const inFlight = new Set<number>();

  async function onCommitted(details: CommittedDetails): Promise<void> {
    const tabId = details.tabId;
    if (details.frameId !== 0 || tabId < 0 || inFlight.has(tabId)) return;
    const page = pageOf(details.url);
    if (!page) return;
    const at = now();
    const last = sent.get(tabId);
    if (last && at - last.at < perTabMs) return;

    inFlight.add(tabId);
    try {
      const settings = await deps.settings();
      if (!settings.enabled) return;
      if (isSiteOff(settings, page.host) || isDenylisted(page.host)) return;

      const [notes, history, tabs, goal] = await Promise.all([
        deps.notes(tabId).catch(() => []),
        deps.history(tabId, at).catch(() => []),
        deps.tabs?.(tabId).catch(() => []) ?? [],
        deps.goal?.().catch(() => undefined) ?? undefined,
      ]);
      // With nothing read and nothing done, the prefix is the static part alone,
      // which the provider has cached since the first page of the session.
      if (notes.length === 0 && history.length === 0) return;

      const provider = (deps.createProvider ?? createProvider)(settings);
      // A race of the regex placeholder and Jev has no prefix to put anywhere.
      if (!provider.warm || (provider instanceof RaceProvider && !provider.warms)) return;
      const req: NextActionRequest = {
        page: { host: page.host, title: '', path: page.path, scroll: { y: 0, pages: 1, more: false } },
        outline: WARMUP_OUTLINE,
        controls: [],
        history,
        notes,
        ...(goal ? { goal } : {}),
        tabs,
        now: new Date(at).toISOString(),
        eagerness: settings.eagerness,
      };
      sent.set(tabId, { at, prefix: fnv1a(renderPrefix(req)) });
      deps.onWarm?.(tabId, page.host);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), abortMs);
      try {
        await provider.warm(req, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // A warm-up that does not happen costs latency, never correctness.
    } finally {
      inFlight.delete(tabId);
    }
  }

  return {
    onCommitted,
    attach(navigation) {
      navigation.onCommitted.addListener((d) => void onCommitted(d).catch(() => undefined));
    },
    warmed(tabId, req, at = now()) {
      if (tabId === undefined) return false;
      const last = sent.get(tabId);
      if (!last || at - last.at > WARM_LIMITS.freshWarmMs) return false;
      return last.prefix === fnv1a(renderPrefix(req));
    },
    forget(tabId) {
      sent.delete(tabId);
    },
  };
}

function pageOf(url: string): { host: string; path: string } | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return { host: u.host, path: u.pathname };
  } catch {
    return undefined;
  }
}

export const KEEP_WARM_ALARM = 'carat-keep-warm';

/**
 * Half a minute, which is also as fast as `chrome.alarms` will go: anything
 * under `periodInMinutes: 0.5` is clamped to 30 seconds. That is under the
 * service worker's own 30-second idle timeout, so the tick keeps the worker
 * on its feet — and with it the settings, the notes and the open connections
 * the next request would otherwise wait on.
 */
export const KEEP_WARM_PERIOD_MINUTES = 0.5;

/** The slice of `chrome.alarms` the keep-warm tick uses. */
export interface AlarmsApi {
  create(name: string, info: { periodInMinutes: number }): void | Promise<void>;
  clear(name: string): boolean | Promise<boolean> | void;
  get?(name: string): Promise<{ name: string } | undefined>;
}

export interface KeepWarmDeps {
  alarms: AlarmsApi;
  /** Where the notes and the timeline live: `chrome.storage.session`. */
  area: StorageArea;
  now?: () => number;
  materialMs?: number;
}

export interface KeepWarm {
  /** Decide whether the tick should be running, and start or stop it. Returns whether it is on. */
  check(): Promise<boolean>;
  /** The alarm fired. Being awake is the whole job; it re-checks and stands itself down when there is nothing left. */
  onTick(): Promise<boolean>;
}

/**
 * The worker is only worth keeping alive while there is something for it to
 * answer with. A note or a timeline entry under half an hour old is that
 * something: the tick runs, the worker stays up, and the first request after
 * it does not pay for a cold start. Once the last of it has aged out the
 * alarm is cleared and Chrome may shut the worker down, as it should.
 */
export function createKeepWarm(deps: KeepWarmDeps): KeepWarm {
  const now = deps.now ?? (() => Date.now());
  const materialMs = deps.materialMs ?? WARM_LIMITS.materialMs;
  let running = false;

  async function on(): Promise<void> {
    if (running || (deps.alarms.get && (await deps.alarms.get(KEEP_WARM_ALARM)))) {
      running = true;
      return;
    }
    await deps.alarms.create(KEEP_WARM_ALARM, { periodInMinutes: KEEP_WARM_PERIOD_MINUTES });
    running = true;
  }

  async function off(): Promise<void> {
    // A worker that just woke has no memory of its alarms, so only a `get` that
    // says there is none lets this skip the clear.
    if (!running && deps.alarms.get && !(await deps.alarms.get(KEEP_WARM_ALARM))) return;
    await deps.alarms.clear(KEEP_WARM_ALARM);
    running = false;
  }

  async function check(): Promise<boolean> {
    const at = now();
    const fresh = at - (await newestMark(deps.area)) < materialMs;
    if (fresh) await on();
    else await off();
    return fresh;
  }

  return {
    check,
    onTick: check,
  };
}

/**
 * The newest note or timeline entry in the session store, or -Infinity when
 * there is neither. Read straight from the area rather than through the two
 * stores, which have no "when was the last thing" of their own.
 */
export async function newestMark(area: StorageArea): Promise<number> {
  let newest = Number.NEGATIVE_INFINITY;
  try {
    const raw = await area.get([NOTES_KEY, HISTORY_KEY]);
    for (const note of asArray(raw[NOTES_KEY])) newest = Math.max(newest, stamp(note, 'at'));
    const timeline = raw[HISTORY_KEY];
    if (timeline && typeof timeline === 'object' && !Array.isArray(timeline)) {
      for (const list of Object.values(timeline as Record<string, unknown>)) {
        for (const entry of asArray(list)) newest = Math.max(newest, stamp(entry, 't'));
      }
    }
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
  return newest;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function stamp(v: unknown, key: 'at' | 't'): number {
  if (!v || typeof v !== 'object') return Number.NEGATIVE_INFINITY;
  const n = (v as Record<string, unknown>)[key];
  return typeof n === 'number' && Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}
