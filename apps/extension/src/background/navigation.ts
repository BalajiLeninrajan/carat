import type { ActionSuggestion, NavSuggestion, PageMeta } from '@carat/shared';
import { buildIntentUrl, intentLabel, isIntentDestination, isIntentName } from '@carat/shared';
import type { Requester } from './requester';

/** The slice of a chrome.tabs.Tab the resolver needs. */
export interface OpenTab {
  id: number;
  url: string;
}

/** The chrome.tabs calls navigation performs; injected so tests never touch chrome.* */
export interface TabsApi {
  get(tabId: number): Promise<{ id?: number; url?: string; windowId?: number } | undefined>;
  update(tabId: number, props: { url: string; active: boolean }): Promise<unknown>;
  create(props: { url: string; openerTabId?: number }): Promise<unknown>;
  focusWindow(windowId: number): Promise<unknown>;
}

/**
 * Turn the provider's actions into chips. The registry builds the URL from the
 * entity; an open tab already at the destination turns "open" into "focus".
 * An action aimed at the page the user is on, or one the registry cannot
 * build a URL for, is dropped.
 */
export function resolveNavigation(
  actions: ActionSuggestion[],
  tabs: OpenTab[],
  requester: Requester,
  page: PageMeta,
): NavSuggestion[] {
  const here = `https://${page.host}${page.path}`;
  const out: NavSuggestion[] = [];
  for (const a of actions) {
    if (isIntentDestination(a.intent, here)) continue;
    const url = buildIntentUrl(a.intent, a);
    if (!url) continue;
    const existing = tabs.find((t) => t.id !== requester.tabId && isIntentDestination(a.intent, t.url));
    const kind = existing ? 'focus' : 'open';
    out.push({
      kind,
      intent: a.intent,
      label: intentLabel(a.intent, kind),
      value: a.value,
      when: a.when,
      location: a.location,
      url,
      ...(existing ? { tabId: existing.id } : {}),
      confidence: a.confidence,
      reason: a.reason,
      sourceContextId: a.sourceContextId,
    });
  }
  return out;
}

/**
 * Runs only when a content script reports that the user pressed Tab on a
 * navigation chip. The URL is rebuilt from the registry rather than trusted
 * from the message, and a focus target that has since closed or moved away
 * from the destination falls back to a new tab.
 */
export async function performNavigation(
  nav: NavSuggestion,
  sender: { tab?: { id?: number } },
  tabs: TabsApi,
): Promise<{ ok: boolean }> {
  if (!sender.tab || !isIntentName(nav.intent)) return { ok: false };
  const url = buildIntentUrl(nav.intent, nav);
  if (!url) return { ok: false };

  if (nav.kind === 'focus' && nav.tabId !== undefined && nav.tabId !== sender.tab.id) {
    const tab = await tabs.get(nav.tabId).catch(() => undefined);
    if (tab?.id !== undefined && tab.url && isIntentDestination(nav.intent, tab.url)) {
      await tabs.update(tab.id, { url, active: true });
      if (tab.windowId !== undefined) await tabs.focusWindow(tab.windowId).catch(() => undefined);
      return { ok: true };
    }
  }
  const opener = sender.tab.id;
  await tabs.create(opener === undefined ? { url } : { url, openerTabId: opener });
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

export async function openTabs(): Promise<OpenTab[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.flatMap((t) => (t.id !== undefined && t.url ? [{ id: t.id, url: t.url }] : []));
}
