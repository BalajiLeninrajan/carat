import { defineBackground } from 'wxt/utils/define-background';
import { isDenylisted } from '@carat/shared';
import { createVisionProvider } from '@carat/providers';
import { onMessage, sendMessage } from '../src/messaging';
import { ContextStore, ShotStore, createSettingsStore, isSiteOff, parseLocation } from '../src/store';
import {
  DiagLog,
  HistoryStore,
  RefineQueue,
  chromeTabsApi,
  clearActionCache,
  clearKnown,
  createNotes,
  createVisionPipeline,
  describeStatus,
  describedTabs,
  getKnown,
  handleFeedback,
  isExtensionPage,
  nextAction,
  performNavigation,
  redactSettings,
  requesterFromSender,
  setPinned,
} from '../src/background';
import type { CaptureVerdict, ScreenApi } from '../src/background';

const SWEEP_ALARM = 'carat-sweep';
const SUGGEST_COMMAND = 'carat-suggest';

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
  // What the user did, per tab: clicks and typing from the page, navigations and carat's own chips from here.
  const history = new HistoryStore(chrome.storage.session);
  history.attach(chrome.webNavigation, chrome.tabs);
  // What they read elsewhere, distilled by the same model the engine uses.
  const notes = createNotes({
    area: chrome.storage.session,
    distill: async (text, host, signal) => {
      const provider = createVisionProvider(await settings.get());
      return provider ? provider.distill(text, host, signal) : [];
    },
    pinned: () => store.isPinned(),
  });
  const vision = createVisionPipeline({
    store,
    shots,
    settings: () => settings.get(),
    tabs: screenApi(),
    onDiag: (tabId, d) => void diag.recordVision(tabId, d),
    onText: (item) => notes.onCapture(item, true),
  });

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
    // A page the user is leaving is finished being read, so it is distilled now.
    if (item) notes.onCapture(item, data.leaving === true);
    return note(item ? 'stored' : 'empty');
  });

  // What the user just did on the page, batched by the content script.
  onMessage('history', ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) void history.recordAll(tabId, data.entries).catch(() => undefined);
  });

  // Fire and forget from the content script's side; a picture or a model call must never hold a message port.
  onMessage('vision', ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) void vision.handle(data, tabId).catch(() => undefined);
  });

  onMessage('nextAction', async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    try {
      return await nextAction(data, requesterFromSender(sender, data.page), {
        settings: () => settings.get(),
        history,
        notes: { lines: async () => notes.top({ tabId }) },
        tabs: () => describedTabs(tabId),
        refine,
        ...(tabId !== undefined ? { onDiag: (d) => void diag.recordSuggest(tabId, d) } : {}),
      });
    } catch {
      return { action: null };
    }
  });

  onMessage('nextActionRefine', async ({ data, sender }) => {
    try {
      return await refine.claim(data.ticket, sender.tab?.id);
    } catch {
      return {};
    }
  });

  // Tab and Esc on the chip: the timeline learns what happened, and Esc keeps that control quiet for a while.
  onMessage('feedback', ({ data, sender }) =>
    handleFeedback(data, store, sender.tab?.id, {
      onPerform: (tabId, entry) => void diag.recordPerform(tabId, entry),
      onHistory: (tabId, line) => {
        if (tabId === undefined) return;
        if (data.accepted) void history.recordAccepted(tabId, line).catch(() => undefined);
        else void history.recordDismissed(tabId, line).catch(() => undefined);
      },
    }),
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
    clearActionCache();
    await Promise.all([clearKnown(store), shots.clear(), history.clear(), notes.clear()]);
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
    // The level and the payments setting are part of every request, so what was cached under the old ones is stale.
    clearActionCache();
    return next;
  });

  // The shortcut asks the focused tab's content script to read the page again, past every cache.
  chrome.commands?.onCommand.addListener((command, tab) => {
    if (command !== SUGGEST_COMMAND || tab?.id === undefined) return;
    sendMessage('forceSuggest', undefined, tab.id).catch(() => undefined);
  });

  // Every minute rather than five: a screenshot must not outlive its three-minute TTL by much.
  void chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SWEEP_ALARM) return;
    void store.sweep();
    void shots.sweep();
    void history.sweep();
    void notes.sweep();
  });
});

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
