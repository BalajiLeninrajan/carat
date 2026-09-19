import { defineBackground } from 'wxt/utils/define-background';
import { isDenylisted } from '@carat/shared';
import { onMessage, sendMessage } from '../src/messaging';
import { ContextStore, createSettingsStore, isSiteOff, parseLocation } from '../src/store';
import {
  DiagLog,
  chromeTabsApi,
  clearKnown,
  getKnown,
  handleFeedback,
  isExtensionPage,
  openTabs,
  orchestrate,
  performNavigation,
  redactSettings,
  requesterFromSender,
  setPinned,
} from '../src/background';
import type { CaptureVerdict } from '../src/background';

const SWEEP_ALARM = 'carat-sweep';
const SUGGEST_COMMAND = 'carat-suggest';

export default defineBackground(() => {
  // Constructed eagerly, loaded lazily: the first store call after a wake reads storage.session back.
  const store = new ContextStore(chrome.storage.session);
  const diag = new DiagLog(chrome.storage.session);
  const settings = createSettingsStore(chrome.storage.local);
  const extensionBase = chrome.runtime.getURL('');
  const trusted = (sender: chrome.runtime.MessageSender) => isExtensionPage(sender, extensionBase);
  const tabs = chromeTabsApi();

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
    return note(item ? 'stored' : 'empty');
  });

  onMessage('suggestRequest', async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    try {
      return await orchestrate(data, requesterFromSender(sender, data.page), {
        store,
        settings: () => settings.get(),
        tabs: openTabs,
        ...(tabId !== undefined ? { onDiag: (d) => void diag.recordSuggest(tabId, d) } : {}),
      });
    } catch {
      return { suggestions: [], navigation: [] };
    }
  });

  onMessage('feedback', ({ data }) => handleFeedback(data, store));

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
  onMessage('clearKnown', ({ sender }) => (trusted(sender) ? clearKnown(store) : undefined));
  onMessage('setPinned', async ({ data, sender }) =>
    trusted(sender) ? setPinned(store, data.pinned) : { pinned: await store.isPinned() },
  );
  onMessage('getDiag', async ({ data, sender }) =>
    trusted(sender) ? { diag: (await diag.get(data.tabId)) ?? null } : { diag: null },
  );
  onMessage('getSettings', async ({ sender }) => {
    const s = await settings.get();
    return trusted(sender) ? s : redactSettings(s);
  });
  onMessage('setSettings', async ({ data, sender }) => {
    if (!trusted(sender)) return redactSettings(await settings.get());
    return settings.set(data);
  });

  // The shortcut asks the focused tab's content script to snapshot again, past
  // every cache. A tab with no content script (chrome://, the store) rejects; that is fine.
  chrome.commands?.onCommand.addListener((command, tab) => {
    if (command !== SUGGEST_COMMAND || tab?.id === undefined) return;
    sendMessage('forceSuggest', undefined, tab.id).catch(() => undefined);
  });

  void chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SWEEP_ALARM) void store.sweep();
  });
});
