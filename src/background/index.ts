import {
  PORT_NAME,
  type ContentToWorker,
  type AxSource,
  type WorkerToContent,
  type PredictMessage,
  type PredictedAction,
} from "../shared/types.js";
import { getSettings, setSettings } from "./settings.js";
import { getAxTree, invalidate, sourceFor, detachAll, pointAtNode } from "./ax.js";
import { buildOutline, type Candidate } from "./context.js";
import {
  buildPrompt,
  sanitizeCompletion,
  buildActionPrompt,
  parseAction,
  ACTION_SCHEMA,
  type CandidateInfo,
} from "./prompt.js";
import { streamCompletion, LlmError } from "./llm.js";
import {
  recordAccept,
  recordRequest,
  recordPrediction,
  recordActionAccepted,
  sessionStats,
  lastRequest,
} from "./metrics.js";
import { logEntry, recentHistory } from "./history.js";
import { hostIsBlocked } from "../shared/redact.js";

interface Connection {
  port: chrome.runtime.Port;
  tabId: number | undefined;
  controller: AbortController | null;
  currentReqId: string | null;
  predictController: AbortController | null;
  predictReqId: string | null;
}

/** Action predictions are small JSON; this is room for it plus slack. */
const ACTION_MAX_TOKENS = 160;

const connections = new Set<Connection>();

/** Identical (page, typed text) pairs are common - backspace, retype, undo. */
const CACHE_MAX = 200;
const completionCache = new Map<string, string>();

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

function cacheGet(key: string): string | undefined {
  const hit = completionCache.get(key);
  if (hit === undefined) return undefined;
  // Refresh recency.
  completionCache.delete(key);
  completionCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: string): void {
  completionCache.set(key, value);
  if (completionCache.size > CACHE_MAX) {
    const oldest = completionCache.keys().next().value;
    if (oldest !== undefined) completionCache.delete(oldest);
  }
}

function post(conn: Connection, message: WorkerToContent): void {
  try {
    conn.port.postMessage(message);
  } catch {
    // Port closed mid-flight (navigation). Nothing to do.
  }
}

async function sendState(conn: Connection): Promise<void> {
  const settings = await getSettings();
  post(conn, {
    type: "state",
    enabled: settings.enabled,
    predictActions: settings.predictActions,
    actionConfidence: settings.actionConfidence,
    model: settings.model,
    axSource: conn.tabId != null ? sourceFor(conn.tabId) : "none",
    session: sessionStats(),
  });
}

async function broadcastState(): Promise<void> {
  await Promise.all([...connections].map((conn) => sendState(conn)));
}

async function handleSuggest(conn: Connection, msg: Extract<ContentToWorker, { type: "suggest" }>) {
  const settings = await getSettings();
  const started = performance.now();

  if (!settings.enabled || hostIsBlocked(msg.url, settings.blocklist)) {
    post(conn, { type: "done", reqId: msg.reqId, stats: emptyStats(settings.model, "none", started) });
    return;
  }

  conn.controller?.abort();
  const controller = new AbortController();
  conn.controller = controller;
  conn.currentReqId = msg.reqId;

  // --- context ------------------------------------------------------------
  let outline = msg.fallbackOutline;
  let axSource: AxSource = "fallback";

  if (settings.useAccessibilityTree && msg.topFrame && conn.tabId != null) {
    let nodes = await getAxTree(conn.tabId, msg.url);
    if (nodes) {
      let built = buildOutline(nodes, msg.field, msg.url, msg.title);
      // A cached tree that predates the focus change will not contain the
      // field - one forced refresh is cheaper than a bad suggestion.
      if (!built.focusedFound) {
        invalidate(conn.tabId);
        nodes = await getAxTree(conn.tabId, msg.url);
        if (nodes) built = buildOutline(nodes, msg.field, msg.url, msg.title);
      }
      if (built.text) {
        outline = built.text;
        axSource = "cdp";
      }
    }
  }

  if (controller.signal.aborted) return;

  const { system, user } = buildPrompt(msg.field, outline);
  const key = `${settings.model}::${hash(outline)}::${msg.field.typed}`;

  const cached = cacheGet(key);
  if (cached !== undefined) {
    if (cached) post(conn, { type: "delta", reqId: msg.reqId, text: cached });
    const stats = {
      ttft: 0,
      total: Math.round(performance.now() - started),
      axSource,
      outlineChars: outline.length,
      cached: true,
      model: settings.model,
      prompt: user,
    };
    recordRequest(stats);
    post(conn, { type: "done", reqId: msg.reqId, stats });
    return;
  }

  // --- completion ---------------------------------------------------------
  let ttft = 0;
  let raw = "";
  let emitted = 0;

  try {
    raw = await streamCompletion({
      settings,
      system,
      user,
      singleLine: !msg.field.multiline,
      signal: controller.signal,
      onDelta: (text) => {
        if (controller.signal.aborted) return;
        if (!ttft) ttft = Math.round(performance.now() - started);
        raw += text;
        // Re-sanitize the whole string each time and send only what is new,
        // so the ghost text grows instead of flickering.
        const clean = sanitizeCompletion(raw, msg.field);
        if (clean.length > emitted) {
          post(conn, { type: "delta", reqId: msg.reqId, text: clean.slice(emitted) });
          emitted = clean.length;
        }
      },
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    const fatal = err instanceof LlmError ? err.fatal : false;
    post(conn, {
      type: "error",
      reqId: msg.reqId,
      message: err instanceof Error ? err.message : String(err),
      fatal,
    });
    return;
  }

  if (controller.signal.aborted) return;

  const final = sanitizeCompletion(raw, msg.field);
  cacheSet(key, final);

  const stats = {
    ttft,
    total: Math.round(performance.now() - started),
    axSource,
    outlineChars: outline.length,
    cached: false,
    model: settings.model,
    prompt: user,
  };
  recordRequest(stats);
  post(conn, { type: "done", reqId: msg.reqId, stats });
}

/** Pull "[n] role "name"" candidates back out of a fallback outline's text. */
function candidatesFromText(outline: string): CandidateInfo[] {
  const out: CandidateInfo[] = [];
  for (const match of outline.matchAll(/\[(\d+)\] ([A-Za-z]+)(?: "([^"]*)")?/g)) {
    out.push({ n: Number(match[1]), role: match[2], name: match[3] ?? "" });
  }
  return out;
}

const actionCache = new Map<string, PredictedAction | null>();

async function handlePredict(conn: Connection, msg: PredictMessage) {
  const settings = await getSettings();
  const started = performance.now();

  const reply = (action: PredictedAction | null, resolve: "event" | "index", stats = emptyStats(settings.model, "none", started)) =>
    post(conn, { type: "action", reqId: msg.reqId, action, resolve, stats });

  if (!settings.enabled || !settings.predictActions || hostIsBlocked(msg.url, settings.blocklist)) {
    reply(null, "index");
    return;
  }

  conn.predictController?.abort();
  const controller = new AbortController();
  conn.predictController = controller;
  conn.predictReqId = msg.reqId;

  // --- context ------------------------------------------------------------
  let outline = msg.fallbackOutline;
  let axSource: AxSource = "fallback";
  let cdpCandidates: Candidate[] = [];

  if (settings.useAccessibilityTree && msg.topFrame && conn.tabId != null) {
    // The user just did something, so a cached tree is describing the page as
    // it was before they did it. Predictions are rare enough to pay for fresh.
    invalidate(conn.tabId);
    const nodes = await getAxTree(conn.tabId, msg.url);
    if (nodes) {
      const built = buildOutline(nodes, msg.field, msg.url, msg.title, {
        numberControls: true,
        includeFocusedValue: true,
      });
      if (built.text && built.candidates.length) {
        outline = built.text;
        cdpCandidates = built.candidates;
        axSource = "cdp";
      }
    }
  }

  if (controller.signal.aborted) return;
  if (!outline) {
    reply(null, "index");
    return;
  }

  const history = conn.tabId != null ? await recentHistory(conn.tabId) : [];
  const { system, user } = buildActionPrompt(outline, history);
  const candidates: CandidateInfo[] = axSource === "cdp" ? cdpCandidates : candidatesFromText(outline);
  const resolve = axSource === "cdp" ? "event" : "index";

  // Same page and same recent history -> same answer. Timestamps are left out
  // of the key on purpose; "12s ago" vs "14s ago" is not a different question.
  const key = [settings.model, hash(outline), hash(history.map((h) => h.entry).join("|"))].join("::");

  let ttft = 0;
  let action: PredictedAction | null;
  const cached = actionCache.get(key);

  if (cached !== undefined) {
    action = cached;
  } else {
    let raw: string;
    try {
      raw = await streamCompletion({
        settings,
        system,
        user,
        singleLine: false,
        signal: controller.signal,
        jsonSchema: { name: "next_action", schema: ACTION_SCHEMA },
        maxTokens: ACTION_MAX_TOKENS,
        onDelta: () => {
          if (!ttft) ttft = Math.round(performance.now() - started);
        },
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      post(conn, {
        type: "error",
        reqId: msg.reqId,
        message: err instanceof Error ? err.message : String(err),
        fatal: err instanceof LlmError ? err.fatal : false,
      });
      return;
    }
    if (controller.signal.aborted) return;
    action = parseAction(raw, candidates);
    actionCache.set(key, action);
    if (actionCache.size > 100) actionCache.delete(actionCache.keys().next().value as string);
  }

  // Moving the caret into the field it is already in is not a prediction.
  if (action?.kind === "focus" && outline.includes(`>> FOCUSED [${action.target}] `)) action = null;
  if (action && action.confidence < settings.actionConfidence) action = null;

  if (action && resolve === "event" && conn.tabId != null) {
    const candidate = cdpCandidates.find((c) => c.n === action!.target);
    const pointed = candidate ? await pointAtNode(conn.tabId, candidate.backendNodeId, msg.reqId) : false;
    if (!pointed) action = null;
  }
  if (controller.signal.aborted) return;

  const stats = {
    ttft,
    total: Math.round(performance.now() - started),
    axSource,
    outlineChars: outline.length,
    cached: cached !== undefined,
    model: settings.model,
    prompt: user,
  };
  recordPrediction();
  reply(action, resolve, stats);
}

function emptyStats(model: string, axSource: AxSource, started: number) {
  return {
    ttft: 0,
    total: Math.round(performance.now() - started),
    axSource,
    outlineChars: 0,
    cached: true,
    model,
    prompt: "",
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  const conn: Connection = {
    port,
    tabId: port.sender?.tab?.id,
    controller: null,
    currentReqId: null,
    predictController: null,
    predictReqId: null,
  };
  connections.add(conn);
  void sendState(conn);

  port.onMessage.addListener((raw: ContentToWorker) => {
    switch (raw.type) {
      case "suggest":
        void handleSuggest(conn, raw);
        break;
      case "predict":
        void handlePredict(conn, raw);
        break;
      case "cancel":
        if (conn.currentReqId === raw.reqId) conn.controller?.abort();
        if (conn.predictReqId === raw.reqId) conn.predictController?.abort();
        break;
      case "accepted":
        recordAccept();
        void sendState(conn);
        break;
      case "action-accepted":
        recordActionAccepted();
        void sendState(conn);
        break;
      case "log":
        if (conn.tabId != null) void logEntry(conn.tabId, raw.entry);
        break;
      case "rejected":
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    conn.controller?.abort();
    conn.predictController?.abort();
    connections.delete(conn);
  });
});

/** The options page and popup ask for the last prompt to show in the HUD. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "carat:last-request") {
    sendResponse(lastRequest);
    return true;
  }
  if (message?.type === "carat:settings-changed") {
    void (async () => {
      const settings = await getSettings();
      if (!settings.enabled) await detachAll();
      await broadcastState();
      sendResponse(true);
    })();
    return true;
  }
  return false;
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== "toggle-enabled") return;
  const settings = await getSettings();
  const next = await setSettings({ enabled: !settings.enabled });
  if (!next.enabled) await detachAll();
  await chrome.action.setBadgeText({ text: next.enabled ? "" : "off" });
  await broadcastState();
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.action.setBadgeText({ text: settings.enabled ? "" : "off" });
  if (!settings.apiKey) await chrome.runtime.openOptionsPage();
});
