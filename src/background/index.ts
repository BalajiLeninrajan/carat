import { PORT_NAME, type ContentToWorker, type IdleMessage, type WorkerToContent } from "../shared/protocol.js";
import { isBlocked, loadSettings } from "../shared/settings.js";
import { getTree } from "./axmirror.js";
import { CdpPausedError, isPaused, resume } from "./cdp.js";
import { appendHistory, historyFor, sinceLastInteraction } from "./history.js";
import { buildOutline } from "./outline.js";
import { cancelCompletion, complete } from "./complete.js";
import { acceptAction, cancelPrediction, dismissAction, predictAction } from "./predict.js";
import { buildActionRequest, buildTextRequest } from "./prompts.js";
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
  port.onDisconnect.addListener(() => void chrome.runtime.lastError);
  port.onMessage.addListener(async (msg: ContentToWorker) => {
    switch (msg.type) {
      case "idle":
        onIdle(tabId, msg, post);
        break;
      case "log":
        appendHistory(tabId, msg.entry, msg.url);
        break;
      case "accept": {
        const result = await acceptAction(tabId, msg.reqId);
        post({ type: "result", reqId: msg.reqId, ...result });
        if (!result.ok) console.warn(`[carat] accept refused: ${result.reason}`);
        break;
      }
      case "dismiss":
        dismissAction(tabId, msg.reqId);
        break;
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
  if (typing && !field!.redacted) {
    const textRequest = buildTextRequest({
      settings,
      url: msg.url,
      outline: textOutline.text,
      field: field!,
      axName: textOutline.focused?.name,
      axRole: textOutline.focused?.role,
    });
    console.log(`Text prompt (user turn):\n${textRequest.input[textRequest.input.length - 1].content}`);
  } else {
    const actionRequest = buildActionRequest({ settings, url: msg.url, outline: actionOutline.text, history });
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
    predictAction({ tabId, reqId: msg.reqId, url: msg.url, settings, outline: actionOutline, history, post });

  // Mid-sentence it is the text model's turn. If it has nothing to add, the
  // user has finished the thought: predict what they do next instead.
  if (typing && !field!.redacted && settings.textEnabled) {
    const text = await complete({ tabId, reqId: msg.reqId, url: msg.url, settings, outline: textOutline, field: field!, post });
    if (text === "" && idleSeq.get(tabId) === seq) predict();
    return;
  }
  if (!typing) predict();
}

console.log("[carat] service worker started");
