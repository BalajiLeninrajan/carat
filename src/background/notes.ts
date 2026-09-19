/**
 * Reading memory: short notes about what the user read on pages they have
 * since left, shared across tabs, so a later prompt on another site can use
 * them.
 *
 * When a page is hidden (tab switch, navigation away), the content script
 * sends its visible text; a small model call distills it into at most a few
 * self-contained facts. Only the facts are kept, for an hour, in
 * chrome.storage.session.
 */

import type { SeenMessage } from "../shared/protocol.js";
import type { Settings } from "../shared/settings.js";
import { streamResponse } from "./llm.js";

export interface Note {
  at: number;
  url: string;
  title: string;
  text: string;
}

const NOTES_KEY = "notes";
const MAX_NOTES = 20;
const TTL_MS = 60 * 60_000;
/** Notes shown in a prompt. */
const PROMPT_NOTES = 8;

const NOTES_INSTRUCTIONS = `You help a browser assistant remember what the user just read. You get the visible text of a page the user was looking at before they switched away from it.

Extract the facts the user is likely to act on soon, possibly on a different website: requests or plans addressed to them, things they agreed to, and the concrete details needed to act on them (names, places, dates and times, amounts, quantities, product or item names, reference numbers, addresses, links).

- Write each note as one short, self-contained sentence that makes sense on its own later: say who or what it concerns and include the specifics.
- If the page shows when something was written and a date is relative ("tomorrow", "next Friday"), keep the wording and add the absolute date only if you can work it out from the page.
- Ignore navigation, menus, ads, boilerplate, and anything the user is unlikely to act on.
- Never include passwords, card numbers, or other secrets.
- At most 5 notes. Return an empty list when nothing on the page is actionable.`;

const NOTES_SCHEMA = {
  type: "object",
  properties: { notes: { type: "array", items: { type: "string" } } },
  required: ["notes"],
  additionalProperties: false,
};

async function load(): Promise<Note[]> {
  const stored = await chrome.storage.session.get(NOTES_KEY);
  const now = Date.now();
  return ((stored[NOTES_KEY] as Note[] | undefined) ?? []).filter((n) => now - n.at < TTL_MS);
}

/** Text of the last page distilled per URL, so returning to a tab does not redo the work. */
const lastSeen = new Map<string, string>();

export async function recordSeen(msg: SeenMessage, settings: Settings): Promise<void> {
  const text = msg.text.trim();
  if (text.length < 40 || lastSeen.get(msg.url) === text) return;
  lastSeen.set(msg.url, text);

  const started = performance.now();
  const result = await streamResponse(
    settings,
    {
      model: settings.actionModel,
      instructions: NOTES_INSTRUCTIONS,
      input: [{ role: "user", content: `<page title="${msg.title.replace(/"/g, "'")}" url="${msg.url}">\n${text}\n</page>` }],
      max_output_tokens: 300,
      stream: true,
      store: false,
      reasoning: { effort: "none" },
      text: { format: { type: "json_schema", name: "notes", strict: true, schema: NOTES_SCHEMA } },
    },
    () => {},
    new AbortController().signal,
  );

  let facts: string[] = [];
  try {
    facts = (JSON.parse(result.text).notes as string[]).map((n) => n.trim()).filter(Boolean).slice(0, 5);
  } catch {
    console.warn("[carat] notes: unparseable output", result.text);
    return;
  }
  const host = (() => {
    try {
      return new URL(msg.url).host;
    } catch {
      return msg.url;
    }
  })();
  console.log(
    `[carat] noted ${facts.length} from ${host} · ${Math.round(performance.now() - started)}ms` +
      (facts.length ? "\n" + facts.map((f) => `  - ${f}`).join("\n") : ""),
  );
  if (!facts.length) return;

  const now = Date.now();
  // Replace earlier notes from the same page: the newest reading supersedes them.
  const kept = (await load()).filter((n) => n.url !== msg.url);
  const added = facts.map((text) => ({ at: now, url: msg.url, title: msg.title, text }));
  await chrome.storage.session.set({ [NOTES_KEY]: [...kept, ...added].slice(-MAX_NOTES) });
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "just now" : `${m}m ago`;
}

/** Notes for a prompt on `currentUrl` (notes from that same page are left out: it is on screen). */
export async function notesFor(currentUrl: string): Promise<string> {
  const notes = (await load()).filter((n) => n.url !== currentUrl).slice(-PROMPT_NOTES);
  if (!notes.length) return "(none)";
  const now = Date.now();
  return notes
    .map((n) => {
      let host = n.url;
      try {
        host = new URL(n.url).host;
      } catch {}
      return `- ${n.text} (read ${ago(now - n.at)} on ${host}${n.title ? `, "${n.title.slice(0, 60)}"` : ""})`;
    })
    .join("\n");
}
