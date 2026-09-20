/**
 * Browser-level actions: the things you would do with the tab strip and the
 * address bar rather than with the page.
 *
 * Chrome's own UI is not readable by extensions, so these are offered as extra
 * targets in the prompt ([T1], [T2]...) and carried out through the tabs and
 * search APIs.
 */

/** Open tabs offered to the model, most recently used first. */
const MAX_TABS = 8;

export interface TabTarget {
  n: number;
  tabId: number;
  title: string;
  url: string;
}

export interface BrowserContext {
  /** The <browser> block for the prompt. */
  text: string;
  tabs: TabTarget[];
}

function page(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

/** The other tabs in this window, plus a note of what else Carat can do. */
export async function browserContext(currentTabId: number): Promise<BrowserContext> {
  const all = await chrome.tabs.query({ currentWindow: true });
  const others = all
    .filter((t) => t.id != null && t.id !== currentTabId && /^https?:/.test(t.url ?? ""))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .slice(0, MAX_TABS);

  const tabs: TabTarget[] = others.map((t, i) => ({
    n: i + 1,
    tabId: t.id!,
    title: t.title ?? "",
    url: t.url ?? "",
  }));
  const lines = tabs.map((t) => `  [T${t.n}] tab "${t.title.slice(0, 70)}" (${page(t.url)})`);
  const text =
    (lines.length ? `other open tabs:\n${lines.join("\n")}\n` : "no other tabs are open\n") +
    `you can also: open a URL or run a search in this tab`;
  return { text, tabs };
}

export type BrowserResult = { ok: true } | { ok: false; reason: string };

export async function switchToTab(target: TabTarget): Promise<BrowserResult> {
  try {
    const tab = await chrome.tabs.get(target.tabId);
    await chrome.tabs.update(target.tabId, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    return { ok: true };
  } catch {
    return { ok: false, reason: "That tab is gone." };
  }
}

/** Looks like something you would type in the address bar and get a page, not a search. */
function asUrl(text: string): string | null {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`;
  return null;
}

/**
 * Address-bar behaviour: a URL navigates, anything else searches with the
 * user's own default engine.
 */
export async function openOrSearch(tabId: number, text: string, newTab = false): Promise<BrowserResult> {
  const url = asUrl(text);
  try {
    if (url) {
      if (newTab) await chrome.tabs.create({ url });
      else await chrome.tabs.update(tabId, { url });
      return { ok: true };
    }
    await chrome.search.query({ text, disposition: newTab ? "NEW_TAB" : "CURRENT_TAB" });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Could not open that." };
  }
}

/** Resolve after the tab has finished loading (or straight away if it is idle). */
export function waitForLoad(tabId: number, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && setTimeout(finish, 250), finish);
  });
}
