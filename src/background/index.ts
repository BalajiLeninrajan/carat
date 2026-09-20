import { PORT_NAME, TASK_REQ, type ContentToWorker, type IdleMessage, type WorkerToContent } from "../shared/protocol.js";
import { isBlocked, loadSettings } from "../shared/settings.js";
import { getTree } from "./axmirror.js";
import { browserContext } from "./browser.js";
import { CdpPausedError, isPaused, resume } from "./cdp.js";
import { appendHistory, historyFor, sinceLastInteraction } from "./history.js";
import { notesFor, recordSeen } from "./notes.js";
import { buildOutline } from "./outline.js";
import { cancelCompletion, complete } from "./complete.js";
import { acceptAction, cancelPrediction, dismissAction, predictAction } from "./predict.js";
import { answerTask, confirmTask, hasTask, resumeTask, startTask, stopTask } from "./task.js";
import { buildActionRequest, buildTextRequest } from "./prompts.js";
import "./listen.js";
import "./visits.js";

/** A page load only triggers a prediction if the user did something this recently. */
const FLOW_WINDOW_MS = 60_000;

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await loadSettings();
  if (details.reason === "install" && !settings.apiKey) chrome.runtime.openOptionsPage();
});

// With no popup, clicking the toolbar icon resumes a tab paused by the debugger banner.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  if (await isPaused(tab.id)) {
    await resume(tab.id);
    console.info(`[carat] resumed tab ${tab.id}`);
  } else {
    chrome.runtime.openOptionsPage();
  }
});

/** Live content-script connections, so worker-side events can reach a tab. */
const ports = new Map<number, (msg: WorkerToContent) => void>();

/** The tab the user is looking at, so a task's panel can follow them to it. */
let activeTabId: number | undefined;
chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => (activeTabId = t?.id));
chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  const post = ports.get(tabId);
  if (post) resumeTask(tabId, post); // show a running task here too
});

/** Send a task message to the task's own tab and to the tab in front of the user. */
function toTaskViews(taskTabId: number, msg: WorkerToContent): void {
  for (const id of new Set([taskTabId, activeTabId])) {
    if (id != null) ports.get(id)?.(msg);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;
  const post = (msg: WorkerToContent) => {
    try {
      port.postMessage(msg);
    } catch {
      // The page went away; nothing to show it on.
    }
  };
  ports.set(tabId, post);
  // A page load in a tab with a running task lost the panel with the old page.
  resumeTask(tabId, post);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (ports.get(tabId) === post) ports.delete(tabId);
  });
  port.onMessage.addListener(async (msg: ContentToWorker) => {
    switch (msg.type) {
      case "idle":
        onIdle(tabId, msg, post);
        break;
      case "log":
        appendHistory(tabId, msg.entry, msg.url);
        break;
      case "accept": {
        if (msg.reqId === TASK_REQ) {
          confirmTask(tabId, true);
          break;
        }
        const result = await acceptAction(tabId, msg.reqId);
        post({ type: "result", reqId: msg.reqId, ...result });
        if (!result.ok) console.warn(`[carat] accept refused: ${result.reason}`);
        break;
      }
      case "dismiss":
        if (msg.reqId === TASK_REQ) confirmTask(tabId, false);
        else dismissAction(tabId, msg.reqId);
        break;
      case "task":
        startTask(tabId, msg.goal, msg.url, toTaskViews);
        break;
      case "task-answer":
        answerTask(tabId, msg.answer);
        break;
      case "task-stop":
        stopTask(tabId);
        break;
      case "seen": {
        const settings = await loadSettings();
        if (!settings.enabled || !settings.memoryEnabled || !settings.apiKey || isBlocked(settings, msg.url)) break;
        recordSeen(msg, settings).catch((e) => console.error("[carat] noting failed:", e));
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
  if (hasTask(tabId)) return; // the task is driving; its own steps are the suggestions

  const field = msg.field;
  const typing = !!field && !!field.typed.trim() && (msg.reason === "input" || msg.reason === "keydown");
  // A page load alone never sends anything; only the next page of a flow does.
  if (msg.reason === "load" && (await sinceLastInteraction(tabId)) > FLOW_WINDOW_MS) return;

  const started = performance.now();
  let tree;
  try {
    tree = await getTree(tabId, msg.url, msg.pageChanged);
  } catch (e) {
    if (e instanceof CdpPausedError) console.info(`[carat] ${e.message}`);
    else console.error("[carat] AX tree fetch failed:", e);
    return;
  }
  if (idleSeq.get(tabId) !== seq) return;
  const { snapshot, cached } = tree;

  const focusedValue = field && !field.redacted ? field.typed + field.trailing : undefined;
  const common = { url: msg.url, focusedBackendId: snapshot.focusedBackendId };
  const textOutline = buildOutline(snapshot.nodes, { ...common, mode: "text" });
  const actionOutline = buildOutline(snapshot.nodes, { ...common, mode: "action", focusedValue });
  const history = await historyFor(tabId, msg.url);
  const notes = await notesFor(msg.url, settings);
  if (idleSeq.get(tabId) !== seq) return;
  const buildMs = Math.round(performance.now() - started);

  const source = cached ? "cached" : `fetched in ${snapshot.fetchMs}ms`;
  console.groupCollapsed(
    `[carat] idle after ${msg.reason} · tab ${tabId} · ${snapshot.nodes.length} AX nodes (${source}) · ` +
      `outline ${actionOutline.stats.chars} chars, ${actionOutline.candidates.length} targets · ${buildMs}ms`,
  );
  console.log("URL:", msg.url, "| focused backendNodeId:", snapshot.focusedBackendId, "| field:", field);
  console.log("AX tree (raw nodes):", snapshot.nodes);
  console.log(`Text outline (${textOutline.stats.chars} chars):\n${textOutline.text}`);
  console.table(actionOutline.candidates);
  console.log(`Notes:
${notes}`);
  if (typing && !field!.redacted) {
    const textRequest = buildTextRequest({
      settings,
      url: msg.url,
      outline: textOutline.text,
      notes,
      field: field!,
      axName: textOutline.focused?.name,
      axRole: textOutline.focused?.role,
    });
    console.log(`Text prompt (user turn):\n${textRequest.input[textRequest.input.length - 1].content}`);
  } else {
    const actionRequest = buildActionRequest({
      settings,
      url: msg.url,
      outline: actionOutline.text,
      notes,
      history,
      browser: (await browserContext(tabId)).text,
    });
    console.log(`Action prompt (user turn):\n${actionRequest.input[actionRequest.input.length - 1].content}`);
    console.log("Action request body:", actionRequest);
  }
  console.groupEnd();

  if (!settings.apiKey) {
    console.warn("[carat] no API key set; set one in the options page");
    return;
  }
  const predict = () =>
    settings.actionsEnabled &&
    predictAction({ tabId, reqId: msg.reqId, url: msg.url, settings, outline: actionOutline, notes, history, post });

  // Mid-sentence it is the text model's turn. If it has nothing to add, the
  // user has finished the thought: predict what they do next instead.
  if (typing && !field!.redacted && settings.textEnabled) {
    const text = await complete({ tabId, reqId: msg.reqId, url: msg.url, settings, outline: textOutline, notes, field: field!, post });
    if (text === "" && idleSeq.get(tabId) === seq) predict();
    return;
  }
  if (!typing) predict();
}

// Ctrl+Shift+K anywhere in Chrome opens the instruction box on the active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-palette") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const post = tab?.id != null ? ports.get(tab.id) : undefined;
  if (post) post({ type: "palette" });
  else console.warn("[carat] no content script on this tab (reload the page, or it is a chrome:// page)");
});

console.log("[carat] service worker started");
