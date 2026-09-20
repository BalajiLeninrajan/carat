/**
 * Memory: short notes about what the user read on pages they have since left
 * and what was said near them, shared across tabs, so a later prompt on another
 * site can use them.
 *
 * - Read: when a page is hidden (tab switch, navigation away), the content
 *   script sends its visible text.
 * - Heard: background listening sends batches of transcribed speech.
 *
 * Either way a small model call distills the input into at most a few
 * self-contained facts. Only the facts are kept, for an hour, in
 * chrome.storage.session.
 */

import type { SeenMessage } from "../shared/protocol";
import type { Settings } from "../shared/settings";
import { streamResponse } from "./llm";

export interface Note {
  at: number;
  source: "read" | "heard";
  /** Page the note came from ("" for heard notes). */
  url: string;
  title: string;
  text: string;
}

const NOTES_KEY = "notes";
const MAX_NOTES = 30;
const TTL_MS = 60 * 60_000;
/** Notes shown in a prompt. */
const PROMPT_NOTES = 10;
/** Ours: past this, a note is old, and an old note is what a model reaches for when the page offers nothing. */
const OLD_NOTE_MS = 30 * 60_000;
/** Ours: how many old notes get into one prompt. */
const MAX_OLD_NOTES = 2;
/** Ours: a page with less visible text than this was passed through, not read. */
const MIN_SEEN_CHARS = 200;

const COMMON_RULES = `Extract the facts the user is likely to act on soon, possibly on a different website: requests or plans addressed to them, things they agreed to, and the concrete details needed to act on them (names, places, dates and times, amounts, quantities, product or item names, reference numbers, addresses, links).

- Write each note as one short, self-contained sentence that makes sense on its own later: say who or what it concerns and include the specifics.
- If a date is relative ("tomorrow", "next Friday"), keep the wording and add the absolute date only if you can work it out from the input.
- Never include passwords, card numbers, or other secrets.
- At most 5 notes. Return an empty list when nothing is actionable.`;

const READ_INSTRUCTIONS = `You help a browser assistant remember what the user just read. You get the visible text of a page the user was looking at before they switched away from it.

${COMMON_RULES}
- Ignore navigation, menus, ads, boilerplate, and anything the user is unlikely to act on.`;

const HEARD_INSTRUCTIONS = `You help a browser assistant remember what was just said near the user. You get an automatic transcript of speech picked up by their microphone: it has no speaker labels, may include filler words, false starts and mis-heard words, and may include audio from videos or calls.

${COMMON_RULES}
- Speakers are unknown: write "someone said", "the user was asked", or "it was agreed" rather than guessing names for who spoke; names that are spoken are fine to use.
- Ignore small talk, background media that has nothing to do with the user, and anything too garbled to be sure of.
- <already_noted> lists notes taken from earlier speech: do not repeat them; only add what is new or corrects them.`;

const NOTES_SCHEMA = {
  type: "object",
  properties: { notes: { type: "array", items: { type: "string" } } },
  required: ["notes"],
  additionalProperties: false,
};

/** Text of the last page distilled per URL, so returning to a tab does not redo the work. */
const lastSeen = new Map<string, string>();

/** Ours: Alt+Shift+X and the popup's Clear button drop every note. */
export async function clearNotes(): Promise<void> {
  lastSeen.clear();
  await chrome.storage.session.remove(NOTES_KEY);
}

async function load(): Promise<Note[]> {
  const stored = await chrome.storage.session.get(NOTES_KEY);
  const now = Date.now();
  return ((stored[NOTES_KEY] as Note[] | undefined) ?? [])
    .filter((n) => now - n.at < TTL_MS)
    .map((n) => ({ ...n, source: n.source ?? "read" }));
}

async function extract(settings: Settings, instructions: string, content: string): Promise<string[] | null> {
  const result = await streamResponse(
    settings,
    {
      model: settings.actionModel,
      instructions,
      input: [{ role: "user", content }],
      max_output_tokens: 300,
      stream: true,
      store: false,
      reasoning: { effort: "none" },
      text: { format: { type: "json_schema", name: "notes", strict: true, schema: NOTES_SCHEMA } },
    },
    () => {},
    new AbortController().signal,
  );
  try {
    return (JSON.parse(result.text).notes as string[]).map((n) => n.trim()).filter(Boolean).slice(0, 5);
  } catch {
    console.warn("[carat] notes: unparseable output", result.text);
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Ours: pages the user passed through
//
// "Redirecting… | Slack" reached a search box because it was a note, the note
// was a page title, and the page was a redirect hop the user never saw. The
// content script already waits three seconds before it reports a page; these
// are the rest of the ways a page can be one nobody read.

/** Titles a page wears while it is on its way somewhere else. */
const TRANSIENT_TITLE = /^(redirecting|redirect|loading|please wait|just a moment|one moment|signing in|logging in|authori[sz]ing|untitled)\b/i;

/** Paths of the hops a sign-in makes on the way back to the page the user wanted. */
const AUTH_PATH = /(^|\/)(log-?in|sign-?in|sign-?up|log-?out|sign-?out|auth|oauth2?|openid|sso|saml|callback|authorize|consent|verify|session|token)(\/|$)/i;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The site's own name as its host spells it: "slack" from "app.slack.com". */
function siteName(url: string): string {
  const parts = hostOf(url).toLowerCase().replace(/^www\./, "").split(".");
  // Drop the TLD, and the second level of a country pair ("co.uk").
  const drop = parts.length > 2 && (parts[parts.length - 2] ?? "").length <= 3 ? 2 : 1;
  return parts.slice(0, Math.max(1, parts.length - drop)).pop() ?? "";
}

/** Why this page is not worth a note, or null when it is. */
export function transientReason(msg: { url: string; title: string; text: string }): string | null {
  if (msg.text.trim().length < MIN_SEEN_CHARS) return "too little text to have been read";
  const title = msg.title.trim();
  if (!title) return "no title";
  if (TRANSIENT_TITLE.test(title)) return "a redirect or loading title";
  let path = msg.url;
  try {
    path = new URL(msg.url).pathname;
  } catch {
    /* keep the raw string */
  }
  if (AUTH_PATH.test(path)) return "a sign-in or callback hop";
  const site = siteName(msg.url);
  if (site && normalize(title) === site) return "the title is only the site name";
  return null;
}

/** A distilled line that says no more than the title or the host is not a fact. */
function saysNothingNew(fact: string, title: string, url: string): boolean {
  const f = normalize(fact);
  if (!f) return true;
  const t = normalize(title);
  return f === t || (t !== "" && t.includes(f)) || f === siteName(url) || f === normalize(hostOf(url));
}

// ---------------------------------------------------------------------------
// Read

export async function recordSeen(msg: SeenMessage, settings: Settings): Promise<void> {
  const skip = transientReason(msg);
  if (skip) {
    console.log(`[carat] not noting ${hostOf(msg.url)}: ${skip}`);
    return;
  }
  const text = msg.text.trim();
  if (lastSeen.get(msg.url) === text) return;
  lastSeen.set(msg.url, text);

  const started = performance.now();
  const content = `<page title="${msg.title.replace(/"/g, "'")}" url="${msg.url}">\n${text}\n</page>`;
  const distilled = await extract(settings, READ_INSTRUCTIONS, content);
  if (!distilled) return;
  const facts = distilled.filter((f) => !saysNothingNew(f, msg.title, msg.url));
  console.log(
    `[carat] noted ${facts.length} from ${hostOf(msg.url)} · ${Math.round(performance.now() - started)}ms` +
      (facts.length ? "\n" + facts.map((f) => `  - ${f}`).join("\n") : ""),
  );
  if (!facts.length) return;

  const now = Date.now();
  // Replace earlier notes from the same page: the newest reading supersedes them.
  const kept = (await load()).filter((n) => n.source !== "read" || n.url !== msg.url);
  const added: Note[] = facts.map((text) => ({ at: now, source: "read", url: msg.url, title: msg.title, text }));
  await chrome.storage.session.set({ [NOTES_KEY]: [...kept, ...added].slice(-MAX_NOTES) });
}

// ---------------------------------------------------------------------------
// Heard

/**
 * Distill a batch of transcript. `context` is earlier speech already turned
 * into notes, included so a sentence that continues it still makes sense.
 */
export async function recordHeard(lines: string[], context: string[], settings: Settings): Promise<void> {
  const existing = (await load()).filter((n) => n.source === "heard");
  const content =
    `<already_noted>\n${existing.map((n) => `- ${n.text}`).join("\n") || "(none)"}\n</already_noted>\n` +
    (context.length ? `<earlier_speech>\n${context.join("\n")}\n</earlier_speech>\n` : "") +
    `<transcript>\n${lines.join("\n")}\n</transcript>`;

  const started = performance.now();
  const facts = await extract(settings, HEARD_INSTRUCTIONS, content);
  if (!facts) return;
  console.log(
    `[carat] noted ${facts.length} from the microphone · ${Math.round(performance.now() - started)}ms` +
      (facts.length ? "\n" + facts.map((f) => `  - ${f}`).join("\n") : ""),
  );
  if (!facts.length) return;

  const now = Date.now();
  const added: Note[] = facts.map((text) => ({ at: now, source: "heard", url: "", title: "", text }));
  await chrome.storage.session.set({ [NOTES_KEY]: [...(await load()), ...added].slice(-MAX_NOTES) });
}

// ---------------------------------------------------------------------------
// Prompt

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "just now" : `${m}m ago`;
}

/**
 * Ours: notes in prompt order, oldest first, each one dated at the front. The
 * age is what the model is asked to weigh a note by, so it leads the line
 * rather than trailing it, and all but the two newest old notes are dropped.
 * `notes` arrives oldest first.
 */
export function renderNotes(notes: Note[], now: number): string {
  const old = notes.filter((n) => now - n.at >= OLD_NOTE_MS);
  const dropped = new Set(old.slice(0, Math.max(0, old.length - MAX_OLD_NOTES)));
  const kept = notes.filter((n) => !dropped.has(n)).slice(-PROMPT_NOTES);
  if (!kept.length) return "(none)";
  return kept
    .map((n) => {
      const when = ago(now - n.at);
      return n.source === "heard"
        ? `- ${when}, heard: ${n.text}`
        : `- ${when}, read on ${hostOf(n.url)}${n.title ? ` ("${n.title.slice(0, 60)}")` : ""}: ${n.text}`;
    })
    .join("\n");
}

/**
 * Notes for a prompt on `currentUrl`. Read notes from that same page are left
 * out (it is on screen), and each source only counts while its feature is on.
 */
export async function notesFor(currentUrl: string, settings: Settings): Promise<string> {
  const notes = (await load()).filter((n) =>
    n.source === "read" ? settings.memoryEnabled && n.url !== currentUrl : settings.listenEnabled,
  );
  return renderNotes(notes, Date.now());
}
