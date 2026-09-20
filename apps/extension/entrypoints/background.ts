import { defineBackground } from 'wxt/utils/define-background';
import { isDenylisted } from '@carat/shared';
import { createVisionProvider } from '@carat/providers';
import { onMessage, sendMessage } from '../src/messaging';
import { ContextStore, ShotStore, createSettingsStore, isSiteOff, parseLocation, siteHost } from '../src/store';
// --- clear (balaji/engine-clear) ---
import { clearAll, handleClearCommand } from '../src/background/clear';
// --- end clear ---
import {
  DebugLog,
  DiagLog,
  HistoryStore,
  KEEP_WARM_ALARM,
  RefineQueue,
  chromeTabsApi,
  clearActionCache,
  createGoal,
  createGoalAsk,
  createKeepWarm,
  createNotes,
  createVisionPipeline,
  createWarmer,
  debugSnapshot,
  describeStatus,
  describedTabs,
  getKnown,
  handleDebugCommand,
  handleFeedback,
  isExtensionPage,
  nextAction,
  performNavigation,
  redactSettings,
  requesterFromSender,
  setPinned,
  useAnswerStorage,
} from '../src/background';
import type { CaptureVerdict, ScreenApi } from '../src/background';

const SWEEP_ALARM = 'carat-sweep';
const SUGGEST_COMMAND = 'carat-suggest';

export default defineBackground(() => {
  // Constructed eagerly, loaded lazily: the first store call after a wake reads storage.session back.
  const store = new ContextStore(chrome.storage.session);
  const shots = new ShotStore(chrome.storage.session);
  const diag = new DiagLog(chrome.storage.session);
  // Off for every tab until its debug panel is opened; see DebugLog.
  const debug = new DebugLog(chrome.storage.session);
  const settings = createSettingsStore(chrome.storage.local);
  // The 60 s answer cache is mirrored to session storage, so a page already paid for is not asked about twice.
  useAnswerStorage(chrome.storage.session);
  const extensionBase = chrome.runtime.getURL('');
  const trusted = (sender: chrome.runtime.MessageSender) => isExtensionPage(sender, extensionBase);
  const tabs = chromeTabsApi();
  // Which tickets are open outlives the worker, so a restart mid-answer is
  // told apart from a ticket that closed with nothing better to say.
  const refine = new RefineQueue({ area: chrome.storage.session });
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
  // --- goal (balaji/trust-goal) ---
  // One line for what the user is getting done across tabs, derived from the
  // notes and the timeline after each distillation and each accepted chip.
  const goal = createGoal({
    area: chrome.storage.session,
    notes: (n) => notes.newest(n),
    history: (n) => history.allLines(n),
    ask: async (messages, opts) => {
      const send = createGoalAsk(await settings.get());
      return send ? send(messages, opts) : '';
    },
  });
  const deriveGoal = () => void goal.derive().catch(() => undefined);
  // --- end goal ---
  // Chrome commits a navigation seconds before the content script has an outline;
  // everything in front of the outline is already known, so it goes to the model now.
  const warmer = createWarmer({
    settings: () => settings.get(),
    notes: (tabId) => notes.top({ tabId }),
    history: (tabId, at) => history.lines(tabId, at),
    tabs: (tabId) => describedTabs(tabId),
    // The goal heads the prefix, so a warm-up without it warms the wrong bytes.
    goal: () => goal.current(),
  });
  warmer.attach(chrome.webNavigation);
  chrome.tabs.onRemoved.addListener((tabId) => warmer.forget(tabId));
  // While there is anything recent to answer with, a tick keeps the worker on its feet.
  const keepWarm = createKeepWarm({ alarms: chrome.alarms, area: chrome.storage.session });
  // A navigation is where fresh material comes from, so it is also where the tick starts.
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) void keepWarm.check();
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
    // Whatever that reading added is one of the two things a goal is derived from.
    if (item && data.leaving === true) void notes.flush().then(deriveGoal);
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
    // The extra trace is assembled only for a tab whose panel is open.
    const watching = await debug.isOn(tabId);
    try {
      return await nextAction(data, requesterFromSender(sender, data.page), {
        settings: () => settings.get(),
        history,
        notes: { lines: async () => notes.top({ tabId }) },
        goal: () => goal.current(),
        tabs: () => describedTabs(tabId),
        refine,
        warmed: (id, req) => warmer.warmed(id, req),
        ...(tabId !== undefined
          ? {
              onDiag: (d) => {
                void diag.recordSuggest(tabId, d);
                pushDebug(tabId);
              },
            }
          : {}),
        ...(watching && tabId !== undefined
          ? {
              onDebug: (patch) => {
                if (patch.request) void debug.recordRequest(tabId, patch.request).then(() => pushDebug(tabId));
                if (patch.answer) void debug.recordAnswer(tabId, patch.answer).then(() => pushDebug(tabId));
              },
            }
          : {}),
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
        // An accepted chip is the other thing a goal is derived from: it is the
        // clearest signal there is of what the user is actually doing.
        if (data.accepted) void history.recordAccepted(tabId, line).then(deriveGoal, () => undefined);
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
  onMessage('getKnown', ({ sender }) => (trusted(sender) ? getKnown(store, goal) : { items: [], pinned: false }));
  // --- goal (balaji/trust-goal) ---
  onMessage('clearGoal', async ({ sender }) => {
    if (trusted(sender)) await goal.clear();
  });
  // --- end goal ---
  onMessage('clearKnown', async ({ sender }) => {
    if (!trusted(sender)) return;
    // --- clear (balaji/engine-clear) ---
    await clearFromPopup();
    // --- end clear ---
  });
  onMessage('setPinned', async ({ data, sender }) =>
    trusted(sender) ? setPinned(store, data.pinned) : { pinned: await store.isPinned() },
  );
  onMessage('getDiag', async ({ data, sender }) =>
    trusted(sender) ? { diag: (await diag.get(data.tabId)) ?? null } : { diag: null },
  );

  // The debug panel. A page may only ever ask about the tab it is running in;
  // naming another one is the popup's and the options page's privilege.
  const debugSources = {
    diag,
    debug,
    history,
    settings: () => settings.get(),
    host: async (tabId: number) => {
      try {
        return siteHost((await chrome.tabs.get(tabId)).url) ?? '';
      } catch {
        return '';
      }
    },
  };
  onMessage('getDebug', ({ data, sender }) =>
    debugSnapshot(trusted(sender) ? (data.tabId ?? sender.tab?.id) : sender.tab?.id, debugSources),
  );
  onMessage('setDebug', async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { on: false };
    if (data.on) await debug.open(tabId);
    else await debug.close(tabId);
    return { on: data.on };
  });
  // Every panel is one tab's; a tab that goes takes its trace with it.
  chrome.tabs.onRemoved.addListener((tabId) => void debug.forget(tabId).catch(() => undefined));

  /** The panel repaints from this; a tab with no panel open is never sent one. */
  function pushDebug(tabId: number): void {
    void (async () => {
      if (!(await debug.isOn(tabId))) return;
      const snapshot = await debugSnapshot(tabId, debugSources);
      await sendMessage('debugEvent', snapshot, tabId).catch(() => undefined);
    })().catch(() => undefined);
  }

  // Alt+Shift+D, beside Alt+Shift+C and Alt+Shift+X.
  chrome.commands?.onCommand.addListener((command, tab) => {
    handleDebugCommand(command, tab?.id, {
      toggle: (tabId) => void sendMessage('toggleDebug', undefined, tabId).catch(() => undefined),
    });
  });
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
    // The eagerness level is part of every request, so what was cached under the old one is stale.
    clearActionCache();
    return next;
  });

  // The shortcut asks the focused tab's content script to read the page again, past every cache.
  chrome.commands?.onCommand.addListener((command, tab) => {
    if (command !== SUGGEST_COMMAND || tab?.id === undefined) return;
    sendMessage('forceSuggest', undefined, tab.id).catch(() => undefined);
  });

  // --- clear (balaji/engine-clear) ---
  // Alt+Shift+X, beside Alt+Shift+C: one wipe behind the shortcut and the
  // popup's button, and the tab is told once the stores are empty.
  const wipe = () => clearAll({ store, shots, history, notes, goal });
  const tellCleared = (tabId: number) => void sendMessage('contextCleared', undefined, tabId).catch(() => undefined);
  chrome.commands?.onCommand.addListener((command, tab) => {
    handleClearCommand(command, tab?.id, { clear: wipe, notify: tellCleared });
  });
  // The popup is its own page, so the tab whose chip should go is the active one.
  async function clearFromPopup(): Promise<void> {
    await wipe();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) tellCleared(tab.id);
    } catch {
      // No tab to tell: nothing else to do, the stores are already empty.
    }
  }
  // --- end clear ---

  // Every minute rather than five: a screenshot must not outlive its three-minute TTL by much.
  void chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    // Waking for this is the keep-warm tick's whole purpose; it also decides whether to keep ticking.
    if (alarm.name === KEEP_WARM_ALARM) {
      void keepWarm.onTick();
      return;
    }
    if (alarm.name !== SWEEP_ALARM) return;
    void store.sweep();
    void shots.sweep();
    void history.sweep();
    void notes.sweep();
    // What the sweep just aged out may have been the last reason to stay up.
    void keepWarm.check();
  });

  void keepWarm.check();
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
