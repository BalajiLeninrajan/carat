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

import type { SeenMessage } from "../shared/protocol.js";
import type { Settings } from "../shared/settings.js";
import { streamResponse } from "./llm.js";

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
// Read

/** Text of the last page distilled per URL, so returning to a tab does not redo the work. */
const lastSeen = new Map<string, string>();

export async function recordSeen(msg: SeenMessage, settings: Settings): Promise<void> {
  const text = msg.text.trim();
  if (text.length < 40 || lastSeen.get(msg.url) === text) return;
  lastSeen.set(msg.url, text);

  const started = performance.now();
  const content = `<page title="${msg.title.replace(/"/g, "'")}" url="${msg.url}">\n${text}\n</page>`;
  const facts = await extract(settings, READ_INSTRUCTIONS, content);
  if (!facts) return;
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
 * Notes for a prompt on `currentUrl`. Read notes from that same page are left
 * out (it is on screen), and each source only counts while its feature is on.
 */
export async function notesFor(currentUrl: string, settings: Settings): Promise<string> {
  const notes = (await load())
    .filter((n) => (n.source === "read" ? settings.memoryEnabled && n.url !== currentUrl : settings.listenEnabled))
    .slice(-PROMPT_NOTES);
  if (!notes.length) return "(none)";
  const now = Date.now();
  return notes
    .map((n) =>
      n.source === "heard"
        ? `- ${n.text} (heard ${ago(now - n.at)})`
        : `- ${n.text} (read ${ago(now - n.at)} on ${hostOf(n.url)}${n.title ? `, "${n.title.slice(0, 60)}"` : ""})`,
    )
    .join("\n");
}
