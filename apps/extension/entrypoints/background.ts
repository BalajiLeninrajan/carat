import { defineBackground } from 'wxt/utils/define-background';
import { isDenylisted } from '@carat/shared';
import { onMessage } from '../src/messaging';
import { ContextStore, createSettingsStore, parseLocation } from '../src/store';
import {
  clearKnown,
  getKnown,
  handleFeedback,
  isExtensionPage,
  orchestrate,
  redactSettings,
  requesterFromSender,
  setPinned,
} from '../src/background';

const SWEEP_ALARM = 'carat-sweep';

export default defineBackground(() => {
  // Constructed eagerly, loaded lazily: the first store call after a wake reads storage.session back.
  const store = new ContextStore(chrome.storage.session);
  const settings = createSettingsStore(chrome.storage.local);
  const extensionBase = chrome.runtime.getURL('');
  const trusted = (sender: chrome.runtime.MessageSender) => isExtensionPage(sender, extensionBase);

  onMessage('capture', async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    const location = parseLocation(data.url);
    if (tabId === undefined || !location) return;
    if (isDenylisted(new URL(location.origin).hostname)) return;
    if (!(await settings.get()).enabled) return;
    const input = { tabId, url: data.url, title: data.title, text: data.text };
    if (data.kind === 'selection') await store.upsertSelection(input);
    else await store.upsertPage(input);
  });

  onMessage('suggestRequest', async ({ data, sender }) => {
    try {
      return await orchestrate(data, requesterFromSender(sender, data.page), { store, settings: () => settings.get() });
    } catch {
      return { suggestions: [] };
    }
  });

  onMessage('feedback', ({ data }) => handleFeedback(data, store));

  // The key and the cross-tab context stay with the extension's own pages; a content script gets a redacted view.
  onMessage('getKnown', ({ sender }) => (trusted(sender) ? getKnown(store) : { items: [], pinned: false }));
  onMessage('clearKnown', ({ sender }) => (trusted(sender) ? clearKnown(store) : undefined));
  onMessage('setPinned', async ({ data, sender }) =>
    trusted(sender) ? setPinned(store, data.pinned) : { pinned: await store.isPinned() },
  );
  onMessage('getSettings', async ({ sender }) => {
    const s = await settings.get();
    return trusted(sender) ? s : redactSettings(s);
  });
  onMessage('setSettings', async ({ data, sender }) => {
    if (!trusted(sender)) return redactSettings(await settings.get());
    return settings.set(data);
  });

  void chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SWEEP_ALARM) void store.sweep();
  });
});
