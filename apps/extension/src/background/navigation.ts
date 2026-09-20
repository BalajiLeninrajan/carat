import type { OpenTab } from '@carat/shared';
import { resolveIntentValue } from '@carat/shared';

/** The slice of a chrome.tabs.Tab the resolver needs. */
export interface BrowserTab {
  id: number;
  url: string;
  title: string;
}

/** The chrome.tabs calls navigation performs; injected so tests never touch chrome.* */
export interface TabsApi {
  get(tabId: number): Promise<{ id?: number; url?: string; windowId?: number } | undefined>;
  update(tabId: number, props: { url?: string; active: boolean }): Promise<unknown>;
  create(props: { url: string; openerTabId?: number }): Promise<{ id?: number } | undefined>;
  remove(tabId: number): Promise<unknown>;
  focusWindow(windowId: number): Promise<unknown>;
}

/** What a Tab on an `open` or `switch` left behind, so the undo has something to act on. */
export interface NavigationResult {
  ok: boolean;
  /** The tab carat opened. */
  tabId?: number;
  /** The URL it was opened at; the undo closes it only while it is still there. */
  url?: string;
}

/**
 * Runs only when a content script reports Tab on an `open` or `switch` chip.
 * An `open` is rebuilt from the intent registry rather than trusted from the
 * message, so neither the model nor the page ever supplies a URL; a `switch`
 * only ever brings an open tab forward.
 */
export async function performNavigation(
  data: { kind: 'open' | 'switch'; value: string },
  sender: { tab?: { id?: number } },
  tabs: TabsApi,
): Promise<NavigationResult> {
  if (data.kind === 'switch') {
    const tabId = Number(data.value);
    if (!Number.isInteger(tabId) || tabId === sender.tab?.id) return { ok: false };
    const tab = await tabs.get(tabId).catch(() => undefined);
    if (tab?.id === undefined) return { ok: false };
    await tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await tabs.focusWindow(tab.windowId).catch(() => undefined);
    return { ok: true };
  }
  const resolved = resolveIntentValue(data.value);
  if (!resolved) return { ok: false };
  const opener = sender.tab?.id;
  const opened = await tabs.create(opener === undefined ? { url: resolved.url } : { url: resolved.url, openerTabId: opener });
  return opened?.id === undefined ? { ok: true } : { ok: true, tabId: opened.id, url: resolved.url };
}

/**
 * The other half of a Tab on `open` or `switch`, within the undo window. An
 * `open` closes the tab carat opened and puts the user back where they were,
 * but only while that tab is still on the URL carat opened it at: once they
 * have navigated it, the tab is theirs and closing it would throw away work.
 * A `switch` just brings the tab the chip was on back to the front.
 */
export async function undoNavigation(
  data: { kind: 'open' | 'switch'; tabId?: number; url?: string },
  sender: { tab?: { id?: number; windowId?: number } },
  tabs: TabsApi,
): Promise<{ ok: boolean }> {
  if (data.kind === 'open') {
    if (data.tabId === undefined || !data.url) return { ok: false };
    if (data.tabId === sender.tab?.id) return { ok: false };
    const tab = await tabs.get(data.tabId).catch(() => undefined);
    if (tab?.id === undefined || !sameUrl(tab.url, data.url)) return { ok: false };
    await tabs.remove(tab.id);
  }
  return { ok: await refocus(sender, tabs) };
}

/** Back to the tab the chip was on. */
async function refocus(sender: { tab?: { id?: number; windowId?: number } }, tabs: TabsApi): Promise<boolean> {
  const origin = sender.tab?.id;
  if (origin === undefined) return false;
  await tabs.update(origin, { active: true }).catch(() => undefined);
  const windowId = sender.tab?.windowId ?? (await tabs.get(origin).catch(() => undefined))?.windowId;
  if (windowId !== undefined) await tabs.focusWindow(windowId).catch(() => undefined);
  return true;
}

/** Chrome normalises what it was handed, so the comparison is on the parsed URL, not the string. */
function sameUrl(a: string | undefined, b: string): boolean {
  if (!a) return false;
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

export function chromeTabsApi(): TabsApi {
  return {
    get: (tabId) => chrome.tabs.get(tabId),
    update: (tabId, props) => chrome.tabs.update(tabId, props),
    create: (props) => chrome.tabs.create(props),
    remove: (tabId) => chrome.tabs.remove(tabId),
    focusWindow: (windowId) => chrome.windows.update(windowId, { focused: true }),
  };
}

/** The open tabs as the model sees them: an id, a host and a title it can name in a `switch`. */
export async function openTabs(): Promise<OpenTab[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.flatMap((t) => (t.id !== undefined && t.url ? describe(t.id, t.url, t.title ?? '') : []));
}

export function describe(id: number, url: string, title: string): OpenTab[] {
  try {
    const host = new URL(url).host;
    return host ? [{ id, host, title: title.slice(0, 80) }] : [];
  } catch {
    return [];
  }
}
