/**
 * Background listening: holds the microphone exactly while listening is
 * enabled and a Chrome window has focus, and transcribes the utterances it
 * sends with OpenAI. The offscreen document it runs in is shared with the
 * clipboard reader, so this asks for the document rather than owning it, and
 * says in a message when to take the microphone and when to give it back.
 *
 * Transcribed speech is batched and distilled into notes (see notes.ts) after
 * a pause in talking, or every couple of minutes of continuous talk. Raw
 * transcripts stay in memory only until then; audio is never stored.
 */

import { maskSensitive } from "../shared/redact";
import { loadSettings } from "../shared/settings";
import { recordHeard } from "./notes";
import { closeOffscreen, openOffscreen } from "./offscreen";
/** Alt-tabbing away this briefly does not stop listening mid-sentence. */
const UNFOCUS_GRACE_MS = 3_000;
/** Speech is turned into notes after this long without anyone talking... */
const NOTE_AFTER_PAUSE_MS = 20_000;
/** ...or once this much speech has piled up, whichever comes first. */
const NOTE_AFTER_SPEECH_S = 120;
/** Already-noted lines passed along as context for the next batch. */
const CONTEXT_LINES = 3;

interface HeardLine {
  at: number;
  seconds: number;
  text: string;
}
/** Transcribed but not yet turned into notes. */
let pending: HeardLine[] = [];
/** The last few lines that were, for context. */
let noted: HeardLine[] = [];
let pauseTimer: ReturnType<typeof setTimeout> | undefined;

/** Turn pending speech into notes. */
export async function flush(): Promise<void> {
  clearTimeout(pauseTimer);
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  const context = noted.slice(-CONTEXT_LINES).map((l) => l.text);
  noted = [...noted, ...batch].slice(-CONTEXT_LINES);
  const s = await loadSettings();
  if (!s.apiKey) return;
  await recordHeard(
    batch.map((l) => l.text),
    context,
    s,
  ).catch((e) => console.error("[carat] noting speech failed:", e));
}

let chromeFocused = true;
let unfocusTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------------------
// The microphone (in a document this does not own)

/** Whether the microphone was last asked for. Both messages are idempotent. */
let holding = false;

let queue: Promise<unknown> = Promise.resolve();
function serialized(fn: () => Promise<void>): Promise<void> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function tell(type: string): void {
  chrome.runtime.sendMessage({ type }).catch(() => {});
}

function setBadge(on: boolean): void {
  chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }).catch(() => {});
  chrome.action.setBadgeText({ text: on ? "●" : "" }).catch(() => {});
  chrome.action.setTitle({ title: on ? "Carat is listening" : "Carat" }).catch(() => {});
}

/** Start or stop listening to match settings and window focus. */
export function reconcile(): Promise<void> {
  return serialized(async () => {
    const s = await loadSettings();
    const want = s.enabled && s.listenEnabled && !!s.apiKey && chromeFocused;
    if (want === holding) return;
    holding = want;
    if (want) {
      await openOffscreen("listen");
      tell("carat-listen-start");
      setBadge(true);
      console.log("[carat] listening: on");
    } else {
      // The microphone goes first: the document may stay up for the clipboard.
      tell("carat-listen-stop");
      await closeOffscreen("listen");
      void flush(); // what was said before listening stopped still counts
      setBadge(false);
      console.log(`[carat] listening: off (${!chromeFocused ? "Chrome not focused" : "disabled"})`);
    }
  });
}

// DevTools windows count as Chrome being focused, so watching the service
// worker console does not switch listening off.
chrome.windows.onFocusChanged.addListener(
  (windowId) => {
    clearTimeout(unfocusTimer);
    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
      if (!chromeFocused) {
        chromeFocused = true;
        void reconcile();
      }
      return;
    }
    unfocusTimer = setTimeout(() => {
      chromeFocused = false;
      void reconcile();
    }, UNFOCUS_GRACE_MS);
  },
  { windowTypes: ["normal", "popup", "devtools"] },
);

// The options page writes settings to chrome.storage.local, so flipping the
// toggle starts or stops the microphone without reloading the extension.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void reconcile();
});

chrome.windows.getLastFocused().then(
  (w) => {
    chromeFocused = !!w?.focused;
    void reconcile();
  },
  () => reconcile(),
);

// ---------------------------------------------------------------------------
// Transcription

/** What speech models reliably "hear" in near-silence. Dropped when the clip is short. */
const HALLUCINATIONS = /^(thank you\.?|thanks for watching[.!]?|you|bye\.?|\.|okay\.?)$/i;

async function transcribe(wavBase64: string, seconds: number): Promise<void> {
  const s = await loadSettings();
  if (!s.apiKey) return;
  const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("model", s.transcribeModel);
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "speech.wav");
  form.append("response_format", "json");

  const started = performance.now();
  const res = await fetch(`${s.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.apiKey}` },
    body: form,
  });
  const ms = Math.round(performance.now() - started);
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error?.message ?? message;
    } catch {}
    console.error(`[carat] transcription failed (${res.status}): ${message}`);
    return;
  }
  const text = maskSensitive(String((await res.json()).text ?? "").trim());
  if (!text || (seconds < 3 && HALLUCINATIONS.test(text))) {
    console.log(`[carat] heard ${seconds.toFixed(1)}s · ${ms}ms · (nothing intelligible)`);
    return;
  }

  pending.push({ at: Date.now(), seconds, text });
  console.log(`[carat] heard ${seconds.toFixed(1)}s · ${ms}ms: "${text}"`);
  clearTimeout(pauseTimer);
  if (pending.reduce((sum, l) => sum + l.seconds, 0) >= NOTE_AFTER_SPEECH_S) void flush();
  else pauseTimer = setTimeout(() => void flush(), NOTE_AFTER_PAUSE_MS);
}

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case "carat-utterance":
      transcribe(msg.wav, msg.seconds).catch((e) => console.error("[carat] transcription failed:", e));
      break;
    case "carat-listen-status":
      console.log(`[carat] microphone open: ${msg.device || "default device"} · ${msg.sampleRate} Hz · audio ${msg.state}`);
      break;
    case "carat-listen-heartbeat":
      // Only here to keep the service worker (and the pause timer) alive.
      break;
    case "carat-forget":
      clearTimeout(pauseTimer);
      pending = [];
      noted = [];
      console.log("[carat] forgot pending speech");
      break;
    case "carat-listen-error":
      console.error(
        `[carat] could not open the microphone: ${msg.message}. ` +
          `Grant access with "Enable microphone" on the options page.`,
      );
      break;
  }
});
