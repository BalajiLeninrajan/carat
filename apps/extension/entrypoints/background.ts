import { defineBackground } from 'wxt/utils/define-background';
import { getTree } from '../src/engine/background/axmirror';
import { browserContext } from '../src/engine/background/browser';
import { CdpPausedError, isPaused, resume } from '../src/engine/background/cdp';
import { createClipboardReader } from '../src/engine/background/clipboard';
import { cancelCompletion, complete } from '../src/engine/background/complete';
import { appendHistory, clearHistory, historyFor, sinceLastInteraction } from '../src/engine/background/history';
import { clearNotes, dropSystemCopies, notesFor, recordCopied, recordSeen } from '../src/engine/background/notes';
import { chromeClipboardDocument } from '../src/engine/background/offscreen';
import { buildOutline } from '../src/engine/background/outline';
import {
  acceptAction,
  cancelPrediction,
  dismissAction,
  peekAction,
  predictAction,
  type PredictionTrace,
} from '../src/engine/background/predict';
import {
  createElasticMemory,
  TASK_LINE_PREFIX,
  type ElasticDebugEvent,
  type Observation,
} from '../src/background/elastic';
// Side-effect imports: each keeps its own listeners. listen.ts opens and
// closes the offscreen microphone document to match the listenEnabled setting
// and Chrome's window focus, and turns what it hears into notes.
import '../src/engine/background/listen';
import '../src/engine/background/visits';
import { PORT_NAME, type ActionKind, type ContentToWorker, type IdleMessage, type WorkerToContent } from '../src/engine/shared/protocol';
import { isBlocked, loadSettings, saveSettings, type Settings } from '../src/engine/shared/settings';
import {
  DebugLog,
  describeRequest,
  handleDebugCommand,
  type DebugArea,
  type DebugSnapshot,
} from '../src/debug';
import { onMessage, sendMessage } from '../src/messaging';
import { describeStatus } from '../src/status/info';

/** A page load only triggers a prediction if the user did something this recently. */
const FLOW_WINDOW_MS = 60_000;

/** The ids the manifest gives the three keyboard shortcuts. */
export const COMMANDS = {
  suggest: 'carat-suggest',
  clear: 'clearContext',
  debug: 'toggleDebug',
} as const;

/** How often expired Elastic tasks are swept, in minutes. */
const SWEEP_MINUTES = 1;
const SWEEP_ALARM = 'carat-elastic-sweep';

export default defineBackground(() => {
  const debug = new DebugLog(chrome.storage.session as unknown as DebugArea);

  /**
   * Ours: the Elasticsearch context layer. Optional and best-effort — with no
   * URL or key every call returns immediately, and a failure never reaches the
   * prediction path.
   */
  const elastic = createElasticMemory({ settings: () => loadSettings(), onDebug: logElastic });

  /** Said once per worker, not once per page, so a missing key is noticed but not shouted. */
  let elasticOffNoted = false;

  /**
   * Whether to index and retrieve at all, and a one-time note in the console
   * when the answer is no. Without this the layer is silent in both cases and
   * there is no way to tell "off" from "broken".
   */
  const elasticOn = (settings: Settings): boolean => {
    const on = !!settings.elasticUrl && !!settings.elasticApiKey;
    if (!on && !elasticOffNoted) {
      elasticOffNoted = true;
      console.info('[carat] elastic: off — set a URL and an API key in the options page to index and retrieve');
    }
    return on;
  };

  /**
   * A finished chip: Elastic records it and deletes the task it closed out, so
   * the same suggestion does not come back on the next page.
   */
  const recordChip = (
    tabId: number,
    chip: { kind: ActionKind; label: string; value: string; url: string },
    accepted: boolean,
  ): Promise<void> => {
    console.log(`[carat] elastic → ${accepted ? 'accepted' : 'dismissed'} ${chip.kind}: ${chip.label}`);
    return elastic
      .recordAction({ tabId, host: hostOf(chip.url), kind: chip.kind, label: chip.label, value: chip.value, accepted })
      .catch((e) => console.warn('[carat] elastic recordAction failed:', e));
  };

  /**
   * Expired tasks are dropped in the background, not on the prediction path.
   * Guarded because this is an optional extra: if the alarms permission is
   * ever missing, the sweep should stop, not take the whole worker down with
   * it and leave the browser with no chips at all.
   */
  if (chrome.alarms) {
    void chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_MINUTES });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === SWEEP_ALARM) void elastic.sweepExpiredTasks();
    });
  } else {
    console.warn('[carat] no alarms permission; expired Elastic tasks will not be swept');
  }

  chrome.runtime.onInstalled.addListener(async (details) => {
    const settings = await loadSettings();
    if (details.reason === 'install' && !settings.apiKey) void chrome.runtime.openOptionsPage();
  });

  // Clicking the toolbar icon opens the popup; a tab paused by the debugger
  // banner is resumed from there instead.
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id == null) return;
    if (await isPaused(tab.id)) await resume(tab.id);
    else void chrome.runtime.openOptionsPage();
  });

  /** Live content-script connections, so worker-side events can reach a tab. */
  const ports = new Map<number, (msg: WorkerToContent) => void>();

  // -------------------------------------------------------------------------
  // Ours: the clipboard.

  /**
   * Tabs whose content script last reported a visible password field. The
   * system clipboard is never read while one of them is in front.
   */
  const passwordTabs = new Set<number>();

  /**
   * Text copied outside the browser. Off until the user turns the setting on
   * and Chrome grants the optional permission. Copies made on a page arrive
   * over the port instead and need none of this.
   */
  const clipboard = createClipboardReader({
    settings: () => loadSettings(),
    granted: async () => {
      try {
        return await chrome.permissions.contains({ permissions: ['clipboardRead'] });
      } catch {
        return false;
      }
    },
    doc: chromeClipboardDocument(),
    activeTab: async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return undefined;
        return { ...(tab.id !== undefined ? { id: tab.id } : {}), ...(tab.url ? { url: tab.url } : {}) };
      } catch {
        return undefined;
      }
    },
    passwordTab: (tabId) => passwordTabs.has(tabId),
    remember: (copy) => recordCopied(copy),
  });

  const pollClipboard = (): void => void clipboard.poll().catch(() => undefined);
  chrome.tabs.onActivated.addListener(() => pollClipboard());
  chrome.tabs.onRemoved.addListener((tabId) => passwordTabs.delete(tabId));
  // A page the user just landed on is where what they copied elsewhere gets used.
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId === 0) pollClipboard();
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const tabId = port.sender?.tab?.id;
    if (tabId == null) return;
    const post = (msg: WorkerToContent): void => {
      try {
        port.postMessage(msg);
      } catch {
        // The page went away; nothing to show it on.
      }
    };
    ports.set(tabId, post);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (ports.get(tabId) === post) ports.delete(tabId);
    });
    port.onMessage.addListener(async (msg: ContentToWorker) => {
      switch (msg.type) {
        case 'idle':
          // Ours: the one place the worker learns a tab is on a login form.
          if (msg.password) passwordTabs.add(tabId);
          else passwordTabs.delete(tabId);
          void onIdle(tabId, msg, post);
          break;
        case 'log':
          void appendHistory(tabId, msg.entry, msg.url);
          void event(tabId, msg.entry);
          break;
        case 'accept': {
          const chip = peekAction(tabId, msg.reqId);
          const result = await acceptAction(tabId, msg.reqId);
          post({ type: 'result', reqId: msg.reqId, ...result });
          void event(tabId, 'accepted', result.ok ? undefined : result.reason);
          if (!result.ok) console.warn(`[carat] accept refused: ${result.reason}`);
          if (chip && result.ok) void recordChip(tabId, chip, true);
          break;
        }
        case 'dismiss': {
          const chip = peekAction(tabId, msg.reqId);
          dismissAction(tabId, msg.reqId);
          void event(tabId, 'dismissed');
          if (chip) void recordChip(tabId, chip, false);
          break;
        }
        case 'seen': {
          const settings = await loadSettings();
          if (!settings.enabled || !settings.memoryEnabled || !settings.apiKey || isBlocked(settings, msg.url)) break;
          recordSeen(msg, settings)
            .then((added) => {
              if (added.length && elasticOn(settings)) {
                console.log(
                  `[carat] elastic → ${added.length} fact(s) from ${hostOf(msg.url)}\n` +
                    added.map((n) => `  - ${n.text}`).join('\n'),
                );
                void elastic.indexFacts(observationOf(tabId, msg.url, msg.title, msg.text), added);
              }
            })
            .catch((e) => console.error('[carat] noting failed:', e));
          break;
        }
        // Ours: a copy made on the page. Stored as it stands, with no model
        // call and no setting behind it: the page fires `copy` at the content
        // script whatever else Carat is allowed to do.
        case 'copied': {
          const settings = await loadSettings();
          if (!settings.enabled || isBlocked(settings, msg.url)) break;
          recordCopied({ text: msg.text, url: msg.url, title: msg.title }).catch((e) =>
            console.error('[carat] noting a copy failed:', e),
          );
          break;
        }
      }
    });
  });

  /** Latest idle per tab; an older one that finishes late is dropped. */
  const idleSeq = new Map<number, number>();

  async function onIdle(tabId: number, msg: IdleMessage, post: (msg: WorkerToContent) => void): Promise<void> {
    const seq = (idleSeq.get(tabId) ?? 0) + 1;
    idleSeq.set(tabId, seq);
    cancelPrediction(tabId);
    cancelCompletion(tabId);

    const settings = await loadSettings();
    if (!settings.enabled || isBlocked(settings, msg.url)) return;

    const field = msg.field;
    const typing = !!field && !!field.typed.trim() && (msg.reason === 'input' || msg.reason === 'keydown');
    // A page load alone never sends anything; only the next page of a flow does.
    if (msg.reason === 'load' && (await sinceLastInteraction(tabId)) > FLOW_WINDOW_MS) return;

    let tree;
    try {
      tree = await getTree(tabId, msg.url, msg.pageChanged);
    } catch (e) {
      if (e instanceof CdpPausedError) console.info(`[carat] ${e.message}`);
      else console.error('[carat] AX tree fetch failed:', e);
      void event(tabId, 'no page', e instanceof Error ? e.message : String(e));
      return;
    }
    if (idleSeq.get(tabId) !== seq) return;
    const { snapshot, cached } = tree;

    const focusedValue = field && !field.redacted ? field.typed + field.trailing : undefined;
    const common = { url: msg.url, focusedBackendId: snapshot.focusedBackendId };
    const textOutline = buildOutline(snapshot.nodes, { ...common, mode: 'text' });
    const actionOutline = buildOutline(snapshot.nodes, { ...common, mode: 'action', focusedValue });
    const history = await historyFor(tabId, msg.url);
    // The accessibility tree is what Elastic remembers this page by: the same
    // outline the model reads, not a separate DOM scrape.
    if (elasticOn(settings)) {
      console.log(
        `[carat] elastic → observation · ${hostOf(msg.url)} · ${textOutline.text.length} chars of AX outline` +
          ` · ${actionOutline.candidates.length} controls · "${msg.title.slice(0, 60)}"`,
      );
      void elastic.indexObservation(observationOf(tabId, msg.url, msg.title, textOutline.text));
    }
    const retrieveLines = async (): Promise<string[]> => {
      if (!elasticOn(settings)) return [];
      try {
        const lines = await elastic.retrieve(
          {
            url: msg.url,
            title: msg.title,
            text: actionOutline.text,
            candidates: actionOutline.candidates,
            focused: actionOutline.focused,
            history,
          },
          tabId,
        );
        if (lines.length) console.log(`[carat] elastic \u2190 ${lines.length} line(s)\n${lines.map((l) => `  ${l}`).join('\n')}`);
        else console.log('[carat] elastic \u2190 nothing for this page');
        return lines;
      } catch (e) {
        console.warn('[carat] elastic retrieve failed:', e);
        return [];
      }
    };
    const [ownNotes, elasticLines] = await Promise.all([notesFor(msg.url, settings), retrieveLines()]);
    // The task line leads; the user's own notes keep their place ahead of the
    // supporting context, so retrieval can never crowd out what they read.
    const notes = mergeNotes(ownNotes, elasticLines);
    if (idleSeq.get(tabId) !== seq) return;

    console.log(
      `[carat] idle after ${msg.reason} · tab ${tabId} · ${snapshot.nodes.length} AX nodes ` +
        `(${cached ? 'cached' : `fetched in ${snapshot.fetchMs}ms`}) · ` +
        `outline ${actionOutline.stats.chars} chars, ${actionOutline.candidates.length} targets`,
    );
    void event(
      tabId,
      `idle after ${msg.reason}`,
      `${actionOutline.candidates.length} targets · ${cached ? 'cached tree' : `tree in ${snapshot.fetchMs}ms`}`,
    );

    if (!settings.apiKey) {
      console.warn('[carat] no API key set; set one in the options page');
      return;
    }

    const trace: PredictionTrace | undefined = (await debug.isOn(tabId))
      ? {
          request: (request, candidates) => {
            void debug.recordRequest(tabId, describeRequest(request, candidates)).then(() => push(tabId));
          },
          answer: (answer) => {
            void debug.recordAnswer(tabId, { at: Date.now(), ...answer }).then(() => push(tabId));
          },
        }
      : undefined;

    const predict = (): void => {
      if (!settings.actionsEnabled) return;
      void predictAction({
        tabId,
        reqId: msg.reqId,
        url: msg.url,
        settings,
        outline: actionOutline,
        notes,
        history,
        below: msg.moreBelow === true,
        selection: msg.selection ?? '',
        ...(trace ? { trace } : {}),
        post,
      });
    };

    // Mid-sentence it is the text model's turn. If it has nothing to add, the
    // user has finished the thought: predict what they do next instead.
    if (typing && !field.redacted && settings.textEnabled) {
      const text = await complete({
        tabId,
        reqId: msg.reqId,
        url: msg.url,
        settings,
        outline: textOutline,
        notes,
        field,
        post,
      });
      if (text === '' && idleSeq.get(tabId) === seq) predict();
      return;
    }
    if (!typing) predict();
  }

  // -------------------------------------------------------------------------
  // The debug panel

  async function snapshotFor(tabId: number | undefined): Promise<DebugSnapshot> {
    const at = Date.now();
    if (tabId === undefined) {
      return {
        at,
        tabId: null,
        on: false,
        debug: null,
        history: '(nothing yet)',
        gate: { host: '', enabled: false, blocked: false, keySet: false, paused: false },
      };
    }
    const [settings, tab, entry, paused] = await Promise.all([
      loadSettings(),
      chrome.tabs.get(tabId).catch(() => undefined),
      debug.get(tabId).catch(() => null),
      isPaused(tabId).catch(() => false),
    ]);
    const url = tab?.url ?? '';
    return {
      at,
      tabId,
      on: entry?.on === true,
      debug: entry,
      history: await historyFor(tabId, url).catch(() => '(nothing yet)'),
      gate: {
        host: hostOf(url),
        enabled: settings.enabled,
        blocked: url !== '' && isBlocked(settings, url),
        keySet: settings.apiKey !== '',
        paused,
      },
    };
  }

  /** The panel is open on this tab: push it whatever just changed. */
  function push(tabId: number): void {
    void debug.isOn(tabId).then(async (on) => {
      if (!on) return;
      await sendMessage('debugEvent', await snapshotFor(tabId), tabId).catch(() => undefined);
    });
  }

  /** One line in the panel's timeline, from the worker's side. */
  async function event(tabId: number, name: string, detail?: string): Promise<void> {
    if (!(await debug.isOn(tabId))) return;
    await debug.recordEvent(tabId, { at: Date.now(), source: 'engine', name, ...(detail ? { detail } : {}) });
    push(tabId);
  }

  async function toggleDebug(tabId: number): Promise<void> {
    await sendMessage('toggleDebug', undefined, tabId).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Clearing

  /**
   * What "clear" means, in one place: the popup's button and Alt+Shift+X both
   * end here. Settings stay — the key, the models, the blocklist, the sound
   * and the status line.
   */
  async function clearAll(): Promise<void> {
    await Promise.all([clearHistory(), clearNotes()]);
  }

  // -------------------------------------------------------------------------
  // Shortcuts

  chrome.commands.onCommand.addListener(async (command, tab) => {
    const tabId = tab?.id;
    if (handleDebugCommand(command, tabId, { toggle: (id) => void toggleDebug(id) })) return;
    if (command === COMMANDS.suggest && tabId !== undefined) {
      await sendMessage('forceSuggest', undefined, tabId).catch(() => undefined);
      return;
    }
    if (command === COMMANDS.clear) {
      await clearAll();
      if (tabId !== undefined) await sendMessage('contextCleared', undefined, tabId).catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // The popup, the options page and the status line

  onMessage('getSettings', () => loadSettings());
  onMessage('setSettings', async ({ data }) => {
    const before = await loadSettings();
    await saveSettings(data as Partial<Settings>);
    const after = await loadSettings();
    // Ours: turning the system clipboard off takes the offscreen document down
    // and drops what it read. Copies made in the browser stay: that half never
    // needed the permission and is not what the user just switched off.
    if (before.clipboardRead && !after.clipboardRead) {
      await clipboard.forget();
      await dropSystemCopies().catch(() => undefined);
    }
    return after;
  });
  onMessage('getStatus', async ({ sender }) => {
    const tabId = sender.tab?.id;
    const paused = tabId === undefined ? false : await isPaused(tabId);
    return describeStatus(await loadSettings(), sender.tab?.url, paused);
  });
  onMessage('clearKnown', () => clearAll());
  onMessage('getDebug', ({ data, sender }) => snapshotFor(data.tabId ?? sender.tab?.id));
  onMessage('setDebug', async ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { on: false };
    if (data.on) await debug.open(tabId);
    else await debug.close(tabId);
    return { on: data.on };
  });

  console.log('[carat] service worker started');
});

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Every Elasticsearch request, in the worker console. The layer is
 * best-effort by design — a bad key or a sleeping deployment is swallowed so
 * the chip still appears — which means without this there is nothing at all
 * to look at when it is not working. Failures carry the response body, since
 * that is where the reason lives.
 */
function logElastic(event: ElasticDebugEvent): void {
  const status = event.status === undefined ? '' : ` ${event.status}`;
  const line = `[carat] elastic ${event.kind}${status} · ${event.summary}`;
  if (event.ok) console.log(line);
  else console.warn(`${line}\n  ${event.path}`, event.response);
}

/** One reading of a page, as the Elastic context layer stores it. */
function observationOf(tabId: number, url: string, title: string, text: string): Observation {
  return { id: `${tabId}:${url}`, tabId, url, title, text, at: Date.now() };
}

/**
 * Elastic returns the task line first and its supporting context after. The
 * task goes above the user's own notes because it names the one thing this
 * page can finish; the context goes below them.
 */
function mergeNotes(own: string, elasticLines: string[]): string {
  if (!elasticLines.length) return own;
  const task = elasticLines.filter((line) => line.startsWith(TASK_LINE_PREFIX));
  const context = elasticLines.filter((line) => !line.startsWith(TASK_LINE_PREFIX));
  const mine = own === '(none)' ? [] : own.split('\n').filter(Boolean);
  const lines = [...task.map((l) => `- ${l}`), ...mine, ...context.map((l) => `- ${l}`)];
  return lines.length ? lines.join('\n') : '(none)';
}
