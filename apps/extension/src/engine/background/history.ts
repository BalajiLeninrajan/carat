/**
 * What the user just did, for the next-action predictor: one timeline shared
 * by every tab, kept in chrome.storage.session so it survives navigations and
 * service-worker restarts (but not a browser restart).
 *
 * When building a prompt for a tab, the timeline is read relative to that tab:
 * - its own entries, and those of the tab that opened it (and that tab's
 *   opener...), are the flow the user is in: they are always eligible;
 * - entries from unrelated tabs only count if they are recent, and only a
 *   few of them, so a music tab in the background does not drown the flow.
 */

export interface HistoryEntry {
  at: number;
  tabId: number;
  url: string;
  entry: string;
  /** Visits name their page in the entry itself, so they get no [on ...] suffix. */
  kind?: "visit";
}

const HISTORY_KEY = "history";
const OPENERS_KEY = "openers";
const MAX_ENTRIES = 60;

/** How many lines the prompt gets in total, and from unrelated tabs. */
const PROMPT_LIMIT = 12;
const OTHER_TAB_LIMIT = 4;
const OTHER_TAB_WINDOW_MS = 10 * 60_000;

// Read-modify-write on storage: serialize so two quick logs cannot race.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/** Ours: Alt+Shift+X and the popup's Clear button wipe the timeline and the tab lineage. */
export function clearHistory(): Promise<void> {
  return serialized(() => chrome.storage.session.remove([HISTORY_KEY, OPENERS_KEY]));
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const stored = await chrome.storage.session.get(HISTORY_KEY);
  return (stored[HISTORY_KEY] as HistoryEntry[] | undefined) ?? [];
}

export interface AppendOptions {
  kind?: "visit";
  /** Replace this tab's latest entry instead of adding one, if it is a visit this recent (ms). */
  replaceVisitWithin?: number;
}

export function appendHistory(tabId: number, entry: string, url: string, opts: AppendOptions = {}): Promise<void> {
  return serialized(async () => {
    const list = await getHistory();
    if (opts.replaceVisitWithin != null) {
      const i = list.findLastIndex((h) => h.tabId === tabId);
      const prev = list[i];
      if (prev?.kind === "visit" && Date.now() - prev.at < opts.replaceVisitWithin) list.splice(i, 1);
    }
    const last = list[list.length - 1];
    // Collapse exact repeats (double clicks, re-focusing the same field).
    if (last && last.tabId === tabId && last.entry === entry && last.url === url) {
      last.at = Date.now();
    } else {
      list.push({ at: Date.now(), tabId, url, entry, ...(opts.kind ? { kind: opts.kind } : {}) });
    }
    await chrome.storage.session.set({ [HISTORY_KEY]: list.slice(-MAX_ENTRIES) });
  });
}

// ---------------------------------------------------------------------------
// Tab lineage: a tab opened from another (link in new tab, window.open)
// continues that tab's flow.

async function getOpeners(): Promise<Record<string, number>> {
  const stored = await chrome.storage.session.get(OPENERS_KEY);
  return (stored[OPENERS_KEY] as Record<string, number> | undefined) ?? {};
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id == null || tab.openerTabId == null) return;
  const { id, openerTabId } = tab;
  serialized(async () => {
    const openers = await getOpeners();
    openers[id] = openerTabId;
    await chrome.storage.session.set({ [OPENERS_KEY]: openers });
  });
});

/** The tab itself, then its opener, its opener's opener... */
async function lineage(tabId: number): Promise<number[]> {
  const openers = await getOpeners();
  const chain = [tabId];
  let cur = openers[tabId];
  while (cur != null && !chain.includes(cur)) {
    chain.push(cur);
    cur = openers[cur];
  }
  return chain;
}

// Closed tabs keep their entries (the flow may continue elsewhere); the
// timeline's size cap ages them out.

// ---------------------------------------------------------------------------
// Prompt formatting

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function page(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

/** The history lines for a prompt built in `tabId` on `currentUrl`, oldest first. */
export async function historyFor(tabId: number, currentUrl: string): Promise<string> {
  const [list, chain] = await Promise.all([getHistory(), lineage(tabId)]);
  const now = Date.now();

  const related: HistoryEntry[] = [];
  const others: HistoryEntry[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const h = list[i];
    if (!h) continue;
    if (chain.includes(h.tabId)) {
      if (related.length < PROMPT_LIMIT) related.push(h);
    } else if (others.length < OTHER_TAB_LIMIT && now - h.at < OTHER_TAB_WINDOW_MS) {
      others.push(h);
    }
  }
  const picked = [...related, ...others]
    .sort((a, b) => b.at - a.at)
    .slice(0, PROMPT_LIMIT)
    .reverse();
  if (!picked.length) return "(nothing yet)";

  return picked
    .map((h) => {
      let where = "";
      const on = h.kind === "visit" ? "" : `, on ${page(h.url)}`;
      if (h.tabId === tabId) {
        if (h.url !== currentUrl && on) where = ` [on ${page(h.url)}]`;
      } else if (chain.includes(h.tabId)) {
        where = ` [in the tab that opened this one${on}]`;
      } else {
        where = ` [in another tab${on}]`;
      }
      return `- ${ago(now - h.at)}: ${h.entry}${where}`;
    })
    .join("\n");
}

/**
 * ms since the user last did something (not just a page visit) in this tab or
 * the tab that opened it; Infinity if never. Decides whether a freshly loaded
 * page is part of a flow worth predicting in.
 */
export async function sinceLastInteraction(tabId: number): Promise<number> {
  const [list, chain] = await Promise.all([getHistory(), lineage(tabId)]);
  const last = list.findLast((h) => h.kind !== "visit" && chain.includes(h.tabId));
  return last ? Date.now() - last.at : Infinity;
}
