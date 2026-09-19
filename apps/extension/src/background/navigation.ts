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
  create(props: { url: string; openerTabId?: number }): Promise<unknown>;
  focusWindow(windowId: number): Promise<unknown>;
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
): Promise<{ ok: boolean }> {
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
  await tabs.create(opener === undefined ? { url: resolved.url } : { url: resolved.url, openerTabId: opener });
  return { ok: true };
}

export function chromeTabsApi(): TabsApi {
  return {
    get: (tabId) => chrome.tabs.get(tabId),
    update: (tabId, props) => chrome.tabs.update(tabId, props),
    create: (props) => chrome.tabs.create(props),
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
