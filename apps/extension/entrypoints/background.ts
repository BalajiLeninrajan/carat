import { defineBackground } from 'wxt/utils/define-background';
import { isDenylisted } from '@carat/shared';
import { onMessage, sendMessage } from '../src/messaging';
import { ContextStore, EntityStore, ShotStore, createSettingsStore, isSiteOff, parseLocation } from '../src/store';
import {
  DiagLog,
  RefineQueue,
  chromeTabsApi,
  clearAll,
  createPredictPipeline,
  createPrewarmer,
  createVisionPipeline,
  describeStatus,
  getKnown,
  handleCommand,
  handleFeedback,
  isExtensionPage,
  openTabs,
  orchestrate,
  performNavigation,
  redactSettings,
  requesterFromSender,
  setPinned,
} from '../src/background';
import type { CaptureVerdict, ScreenApi } from '../src/background';

const SWEEP_ALARM = 'carat-sweep';

export default defineBackground(() => {
  // Constructed eagerly, loaded lazily: the first store call after a wake reads storage.session back.
  const store = new ContextStore(chrome.storage.session);
  const shots = new ShotStore(chrome.storage.session);
  const diag = new DiagLog(chrome.storage.session);
  const settings = createSettingsStore(chrome.storage.local);
  const extensionBase = chrome.runtime.getURL('');
  const trusted = (sender: chrome.runtime.MessageSender) => isExtensionPage(sender, extensionBase);
  const tabs = chromeTabsApi();
  const refine = new RefineQueue();
  // Entities are predicted as text is captured, so a suggest request can be answered from them with no call.
  const entities = new EntityStore(chrome.storage.session);
  const predict = createPredictPipeline({ store, entities, settings: () => settings.get() });
  const vision = createVisionPipeline({
    store,
    shots,
    settings: () => settings.get(),
    tabs: screenApi(),
    onDiag: (tabId, d) => void diag.recordVision(tabId, d),
    predict,
  });
  // A navigation onto Maps, Calendar, Gmail or Google search starts the fast call before the page has a DOM.
  // Attached here, at worker start, so the event wakes the worker.
  const prewarm = createPrewarmer({
    store,
    settings: () => settings.get(),
    onDiag: (tabId, d) => void diag.recordPrewarm(tabId, d),
  });
  prewarm.attach(chrome.webNavigation);

  onMessage('capture', async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const location = parseLocation(data.url);
    const host = location ? new URL(location.origin).host : '';
    const note = (verdict: CaptureVerdict) =>
      diag.recordCapture(tabId, { at: Date.now(), host, kind: data.kind, verdict });

    if (!location) return note('not-http');
    if (isDenylisted(new URL(location.origin).hostname)) return note('denylisted');
    const current = await settings.get();
    if (!current.enabled) return note('disabled');
    if (isSiteOff(current, host)) return note('site-off');
    if (await store.isPinned()) return note('pinned');
    const input = { tabId, url: data.url, title: data.title, text: data.text };
    const item = data.kind === 'selection' ? await store.upsertSelection(input) : await store.upsertPage(input);
    if (item) predict.onCapture(item);
    return note(item ? 'stored' : 'empty');
  });

  // Fire and forget from the content script's side; a picture or a model call must never hold a message port.
  onMessage('vision', ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) void vision.handle(data, tabId).catch(() => undefined);
  });

  onMessage('suggestRequest', async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    try {
      return await orchestrate(data, requesterFromSender(sender, data.page), {
        store,
        entities,
        settings: () => settings.get(),
        tabs: openTabs,
        refine,
        vision,
        ...(tabId !== undefined ? { onDiag: (d) => void diag.recordSuggest(tabId, d) } : {}),
      });
    } catch {
      return { suggestions: [], navigation: [], interactions: [] };
    }
  });

  onMessage('suggestRefine', async ({ data, sender }) => {
    try {
      return await refine.claim(data.ticket, sender.tab?.id);
    } catch {
      return { suggestions: [], interactions: [] };
    }
  });

  // Every accepted money control and every fill that stopped short is logged per tab, with the control's name.
  onMessage('feedback', ({ data, sender }) =>
    handleFeedback(data, store, sender.tab?.id, { onPerform: (tabId, entry) => void diag.recordPerform(tabId, entry) }),
  );

  // The only place carat ever opens or focuses a tab, and only in answer to a Tab press on a visible chip.
  onMessage('navigate', async ({ data, sender }) => {
    const current = await settings.get();
    if (!current.enabled) return { ok: false };
    const from = parseLocation(sender.tab?.url ?? '');
    if (from && isSiteOff(current, new URL(from.origin).host)) return { ok: false };
    try {
      return await performNavigation(data, sender, tabs);
    } catch {
      return { ok: false };
    }
  });

  // The key and the cross-tab context stay with the extension's own pages; a content script gets a redacted view.
  onMessage('getKnown', ({ sender }) => (trusted(sender) ? getKnown(store) : { items: [], pinned: false }));
  onMessage('clearKnown', async ({ sender }) => {
    if (!trusted(sender)) return;
    await clearAll({ store, shots, entities });
    // The popup is its own page, so the tab whose chip should go is the active one.
    const tabId = await activeTabId();
    if (tabId !== undefined) tellTab(tabId, 'contextCleared');
  });
  onMessage('setPinned', async ({ data, sender }) =>
    trusted(sender) ? setPinned(store, data.pinned) : { pinned: await store.isPinned() },
  );
  onMessage('getDiag', async ({ data, sender }) =>
    trusted(sender) ? { diag: (await diag.get(data.tabId)) ?? null } : { diag: null },
  );
  // The status line is the one thing a page may learn about settings beyond the redacted view: a verdict and a model name.
  onMessage('getStatus', async ({ sender }) => describeStatus(await settings.get(), sender.tab?.url ?? sender.url));
  onMessage('getSettings', async ({ sender }) => {
    const s = await settings.get();
    return trusted(sender) ? s : redactSettings(s);
  });
  onMessage('setSettings', async ({ data, sender }) => {
    if (!trusted(sender)) return redactSettings(await settings.get());
    const next = await settings.set(data);
    if (!next.screenshots) await shots.clear();
    return next;
  });

  // Alt+Shift+C asks the focused tab's content script to snapshot again, past
  // every cache; Alt+Shift+X wipes the store and tells that tab to drop its chip.
  chrome.commands?.onCommand.addListener((command, tab) => {
    handleCommand(command, tab?.id, {
      clear: () => clearAll({ store, shots, entities }),
      notify: tellTab,
    });
  });

  // Every minute rather than five: a screenshot must not outlive its three-minute TTL by much.
  void chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SWEEP_ALARM) return;
    void store.sweep();
    void shots.sweep();
    void predict.sweep();
  });
});

function tellTab(tabId: number, message: 'forceSuggest' | 'contextCleared'): void {
  sendMessage(message, undefined, tabId).catch(() => undefined);
}

/** The tab a popup click came from; the popup is its own page, so its sender carries no tab. */
async function activeTabId(): Promise<number | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  } catch {
    return undefined;
  }
}

function screenApi(): ScreenApi {
  return {
    async get(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        return { active: tab.active, windowId: tab.windowId };
      } catch {
        return undefined;
      }
    },
    // <all_urls> in host_permissions is what lets this run without activeTab.
    captureVisible: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 }),
  };
}
