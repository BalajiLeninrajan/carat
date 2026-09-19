import type { HistoryEntry } from '../history';
import { HISTORY_LIMITS, asNavHow, navTarget, renderHistory } from '../history';
import type { StorageArea } from '../store/storage-area';

/** Session key for the per-tab timeline, beside the context store's own keys. */
export const HISTORY_KEY = 'tabHistory';

type Timeline = Record<string, HistoryEntry[]>;

/** The `chrome.webNavigation.onCommitted` details the store reads. */
export interface CommittedDetails {
  tabId: number;
  frameId: number;
  url: string;
  transitionType?: string;
  transitionQualifiers?: string[];
}

export interface NavigationEvents {
  onCommitted: { addListener(cb: (d: CommittedDetails) => void): void };
}

export interface TabEvents {
  onCreated: { addListener(cb: (tab: { id?: number; openerTabId?: number }) => void): void };
  onRemoved: { addListener(cb: (tabId: number) => void): void };
}

/**
 * What happened in each tab lately, in `chrome.storage.session`: the clicks
 * and typing the content script reports, the navigations Chrome reports, and
 * carat's own accepted and dismissed chips. Thirty entries per tab and thirty
 * minutes, whichever runs out first. Nothing here reaches
 * `chrome.storage.local`, and no value from a password, card or code field is
 * ever recorded: the content script drops those before sending.
 */
export class HistoryStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly area: StorageArea,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Append one entry to a tab's timeline. An exact repeat of the last one only moves its clock. */
  record(tabId: number, entry: HistoryEntry): Promise<void> {
    return this.edit((map) => {
      const key = String(tabId);
      const list = [...(map[key] ?? [])];
      const last = list[list.length - 1];
      if (last && sameEntry(last, entry)) list[list.length - 1] = { ...last, t: entry.t };
      else list.push(entry);
      return { ...map, [key]: list };
    });
  }

  /** Several at once, as the content script batches a burst. */
  async recordAll(tabId: number, entries: readonly HistoryEntry[]): Promise<void> {
    for (const entry of entries) await this.record(tabId, entry);
  }

  /** A top-frame commit, as `webNavigation` describes it. The query is dropped: it carries ids and tokens. */
  recordNavigation(details: CommittedDetails): Promise<void> {
    if (details.frameId !== 0 || details.tabId < 0) return Promise.resolve();
    const to = navTarget(details.url);
    if (!to) return Promise.resolve();
    return this.record(details.tabId, {
      t: this.now(),
      kind: 'nav',
      how: asNavHow(details.transitionType, details.transitionQualifiers ?? []),
      to,
    });
  }

  /** A tab Chrome opened from another one. */
  recordOpened(tabId: number, openerTabId: number): Promise<void> {
    return this.record(tabId, { t: this.now(), kind: 'opened', from: openerTabId });
  }

  /** Carat's own chip was taken: `click button "Save"`, `fill "Search"`. */
  recordAccepted(tabId: number, what: string): Promise<void> {
    return this.record(tabId, { t: this.now(), kind: 'accepted', what });
  }

  /** Carat's own chip was waved off with Esc. */
  recordDismissed(tabId: number, what: string): Promise<void> {
    return this.record(tabId, { t: this.now(), kind: 'dismissed', what });
  }

  /** The last twelve lines for one tab, oldest first, each with its age. */
  async lines(tabId: number, now: number = this.now()): Promise<string[]> {
    const map = await this.read();
    return renderHistory(map[String(tabId)] ?? [], now);
  }

  /** Everything still held for one tab, oldest first. */
  async entries(tabId: number): Promise<HistoryEntry[]> {
    const map = await this.read();
    return [...(map[String(tabId)] ?? [])];
  }

  forget(tabId: number): Promise<void> {
    return this.edit((map) => {
      if (!(String(tabId) in map)) return map;
      const { [String(tabId)]: _gone, ...rest } = map;
      return rest;
    });
  }

  /** Drop what has aged out. Cheap; runs on the sweep alarm. */
  sweep(): Promise<void> {
    return this.edit((map) => map);
  }

  clear(): Promise<void> {
    const step = this.chain.then(() => this.area.remove([HISTORY_KEY]));
    this.chain = step.catch(() => undefined);
    return step;
  }

  /** One line of wiring in the service worker: navigations, openers and closed tabs. */
  attach(navigation: NavigationEvents, tabs?: TabEvents): void {
    navigation.onCommitted.addListener((d) => void this.recordNavigation(d).catch(() => undefined));
    tabs?.onCreated.addListener((tab) => {
      if (tab.id !== undefined && tab.openerTabId !== undefined) void this.recordOpened(tab.id, tab.openerTabId).catch(() => undefined);
    });
    tabs?.onRemoved.addListener((tabId) => void this.forget(tabId).catch(() => undefined));
  }

  private async read(): Promise<Timeline> {
    const raw = (await this.area.get([HISTORY_KEY]))[HISTORY_KEY];
    return prune(asTimeline(raw), this.now());
  }

  private edit(fn: (map: Timeline) => Timeline): Promise<void> {
    const step = this.chain.then(async () => {
      const raw = (await this.area.get([HISTORY_KEY]))[HISTORY_KEY];
      const next = prune(fn(asTimeline(raw)), this.now());
      if (Object.keys(next).length === 0) await this.area.remove([HISTORY_KEY]);
      else await this.area.set({ [HISTORY_KEY]: next });
    });
    this.chain = step.catch(() => undefined);
    return step;
  }

  /** Resolves once every queued write has reached the storage area. */
  flush(): Promise<void> {
    return this.chain.then(() => undefined);
  }
}

function sameEntry(a: HistoryEntry, b: HistoryEntry): boolean {
  const { t: _at, ...rest } = a;
  const { t: _bt, ...other } = b;
  return JSON.stringify(rest) === JSON.stringify(other);
}

/** Past the TTL, or past the per-tab cap: gone. Applied on every read and every write. */
function prune(map: Timeline, now: number): Timeline {
  const out: Timeline = {};
  for (const [tab, list] of Object.entries(map)) {
    const live = list.filter((e) => now - e.t < HISTORY_LIMITS.ttlMs).slice(-HISTORY_LIMITS.maxEntries);
    if (live.length) out[tab] = live;
  }
  return out;
}

function asTimeline(v: unknown): Timeline {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Timeline = {};
  for (const [tab, list] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(list)) out[tab] = list.filter((e) => e && typeof e === 'object' && typeof (e as HistoryEntry).t === 'number') as HistoryEntry[];
  }
  return out;
}
