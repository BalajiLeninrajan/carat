/**
 * Ghost-text completion: stream the text model's continuation of what the
 * user typed straight to the content script, cleaning it up as it grows.
 */

import type { FieldInfo, WorkerToContent } from "../shared/protocol.js";
import type { Settings } from "../shared/settings.js";
import { streamResponse } from "./llm.js";
import type { Outline } from "./outline.js";
import { buildTextRequest } from "./prompts.js";

const inflight = new Map<number, AbortController>();

/** Recent completions by (page, outline, typed): backspace-and-retype costs nothing. */
const cache = new Map<string, string>();
const CACHE_SIZE = 100;

export function cancelCompletion(tabId: number): void {
  inflight.get(tabId)?.abort();
  inflight.delete(tabId);
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Make raw model output safe to show after `typed`. */
export function clean(raw: string, typed: string, multiline: boolean): string {
  let text = raw;
  if (!multiline) text = text.split(/\r?\n/)[0];
  // Models sometimes wrap the answer in quotes.
  if (/^["“].*["”]$/.test(text.trim()) && !/["“]/.test(typed.slice(-1))) text = text.trim().slice(1, -1);
  // ...or restate the end of what was typed ("Could you" → "you confirm").
  const tailWord = /(\S+)$/.exec(typed)?.[1];
  if (tailWord && tailWord.length >= 3 && text.startsWith(tailWord) && /^(\W|$)/.test(text.slice(tailWord.length))) {
    text = text.slice(tailWord.length);
  }
  // Never double a space.
  if (/\s$/.test(typed)) text = text.replace(/^\s+/, "");
  if (typed.length && text.startsWith(typed)) text = text.slice(typed.length);
  return text.replace(/\s+$/, "");
}

/**
 * Stream a completion for `field` into the page. Resolves with the final
 * suggestion ("" when the model had nothing), or null if it was cancelled.
 */
export async function complete(opts: {
  tabId: number;
  reqId: number;
  url: string;
  settings: Settings;
  outline: Outline;
  notes: string;
  field: FieldInfo;
  post: (msg: WorkerToContent) => void;
}): Promise<string | null> {
  const { tabId, reqId, url, settings, outline, notes, field, post } = opts;
  cancelCompletion(tabId);
  const base = field.typed;
  const key = `${url}|${hash(outline.text + notes)}|${base}`;

  const hit = cache.get(key);
  if (hit != null) {
    post({ type: "ghost", reqId, base, text: hit, done: true });
    console.log(`[carat] ghost (cache) "${hit}"`);
    return hit;
  }

  const controller = new AbortController();
  inflight.set(tabId, controller);
  const request = buildTextRequest({
    settings,
    url,
    outline: outline.text,
    notes,
    field,
    axName: outline.focused?.name,
    axRole: outline.focused?.role,
  });

  let shown = "";
  let stoppedAtNewline = false;
  try {
    const result = await streamResponse(
      settings,
      request,
      (raw) => {
        const text = clean(raw, base, field.multiline);
        // Single-line fields are done at the first newline.
        if (!field.multiline && /\n/.test(raw) && !stoppedAtNewline) {
          stoppedAtNewline = true;
          controller.abort();
        }
        if (text && text !== shown) {
          shown = text;
          post({ type: "ghost", reqId, base, text, done: false });
        }
      },
      controller.signal,
    ).catch((e) => {
      // Our own early stop at a newline is a normal finish.
      if (stoppedAtNewline) return null;
      throw e;
    });

    const final = result ? clean(result.text, base, field.multiline) : shown;
    post({ type: "ghost", reqId, base, text: final, done: true });
    cache.set(key, final);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    console.log(
      `[carat] ghost "${final}"` +
        (result
          ? ` · ttft ${result.ttftMs}ms · total ${result.totalMs}ms · ${result.usage?.input ?? "?"} in (${result.usage?.cached ?? 0} cached) / ${result.usage?.output ?? "?"} out`
          : " · stopped at newline"),
    );
    return final;
  } catch (e) {
    if (controller.signal.aborted) return null;
    console.error("[carat] completion failed:", e);
    post({ type: "ghost", reqId, base, text: "", done: true });
    return null;
  } finally {
    if (inflight.get(tabId) === controller) inflight.delete(tabId);
  }
}
