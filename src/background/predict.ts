/**
 * Next-action prediction for a tab: stream the model's answer, point the
 * content script at the target as soon as `target` has streamed, then send the
 * rest (kind, label, irreversible) once the JSON is complete. Also carries out
 * accepted actions and remembers dismissals.
 */

import type { ActionKind, WorkerToContent } from "../shared/protocol.js";
import type { Settings } from "../shared/settings.js";
import { announceTarget, click, focus, select, type ActuateResult } from "./actuate.js";
import { appendHistory } from "./history.js";
import { partialTarget, streamResponse } from "./llm.js";
import type { Candidate, Outline } from "./outline.js";
import { buildActionRequest } from "./prompts.js";

/** Labels that mean "this cannot be undone": two Tabs, whatever the model says. */
const IRREVERSIBLE = /\b(send|submit|pay|purchase|buy|order|place|checkout|delete|remove|discard|publish|post|confirm|transfer|sign ?out|log ?out|unsubscribe|cancel (my )?(subscription|order|account))\b/i;

interface Pending {
  reqId: number;
  url: string;
  candidate: Candidate;
  kind: ActionKind;
  value: string;
  label: string;
}

interface ParsedAction {
  target: number;
  kind: string;
  value: string;
  label: string;
  irreversible: boolean;
}

/**
 * Recover an action from JSON that was cut off (the output limit hit in the
 * middle of a long fill value). target and kind come first in the schema, so
 * they are almost always complete; a truncated value is trimmed back to its
 * last full sentence (or word) so it never ends mid-word.
 */
export function salvage(json: string): ParsedAction | null {
  const target = /"target"\s*:\s*(\d+)/.exec(json);
  const kind = /"kind"\s*:\s*"(click|fill|select)"/.exec(json);
  if (!target || !kind) return null;

  let value = "";
  const v = /"value"\s*:\s*"((?:[^"\\]|\\.)*)("?)/.exec(json);
  if (v) {
    const raw = v[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, ""); // drop a half-written escape
    try {
      value = JSON.parse(`"${raw}"`);
    } catch {
      value = "";
    }
    if (!v[2]) {
      // Cut off inside the value: back up to the last sentence end, else the last space.
      const sentence = /^[\s\S]*[.!?](?=\s|$)/.exec(value)?.[0];
      value = sentence ?? value.replace(/\s+\S*$/, "");
    }
  }
  const label = /"label"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json)?.[1] ?? "";
  const irreversible = /"irreversible"\s*:\s*true/.test(json);
  return { target: Number(target[1]), kind: kind[1], value: value.trim(), label, irreversible };
}

const inflight = new Map<number, AbortController>();
const pending = new Map<number, Pending>();
/** `${url}|${backendNodeId}` pairs the user dismissed with Esc: never suggested again on that page. */
const dismissed = new Set<string>();

export function cancelPrediction(tabId: number): void {
  inflight.get(tabId)?.abort();
  inflight.delete(tabId);
}

export async function predictAction(opts: {
  tabId: number;
  reqId: number;
  url: string;
  settings: Settings;
  outline: Outline;
  notes: string;
  history: string;
  post: (msg: WorkerToContent) => void;
}): Promise<void> {
  const { tabId, reqId, url, settings, outline, notes, history, post } = opts;
  cancelPrediction(tabId);
  pending.delete(tabId);
  const controller = new AbortController();
  inflight.set(tabId, controller);

  const request = buildActionRequest({ settings, url, outline: outline.text, notes, history });
  let shown: Candidate | null = null;
  /** The early target's announce + "target" message, which must land before "action". */
  let announced: Promise<void> = Promise.resolve();
  let targetMs: number | null = null;
  const started = performance.now();

  const candidateFor = (n: number): Candidate | null => {
    const c = outline.candidates[n - 1];
    if (!c || dismissed.has(`${url}|${c.backendNodeId}`)) return null;
    return c;
  };

  try {
    const result = await streamResponse(
      settings,
      request,
      (json) => {
        if (shown) return;
        const n = partialTarget(json);
        if (n == null || n <= 0) return;
        const c = candidateFor(n);
        if (!c) return;
        shown = c;
        targetMs = Math.round(performance.now() - started);
        announced = announceTarget(tabId, c.backendNodeId)
          .then(() => post({ type: "target", reqId }))
          .catch(() => {});
      },
      controller.signal,
    );

    let parsed: ParsedAction;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      const salvaged = salvage(result.text);
      if (!salvaged) {
        console.warn("[carat] action: unparseable output", result.text);
        post({ type: "clear", reqId });
        return;
      }
      parsed = salvaged;
      console.warn(`[carat] action: output was cut off; salvaged ${parsed.kind} [${parsed.target}] with a ${parsed.value.length}-char value`);
    }

    const c = candidateFor(parsed.target);
    const summary =
      `ttft ${result.ttftMs}ms · target ${targetMs ?? "-"}ms · total ${result.totalMs}ms · ` +
      `${result.usage?.input ?? "?"} in (${result.usage?.cached ?? 0} cached) / ${result.usage?.output ?? "?"} out`;
    if (!c) {
      console.log(`[carat] action → unusable target [${parsed.target}] (not on the page, or dismissed) · ${summary}`);
      post({ type: "clear", reqId });
      return;
    }
    await announced;
    const early = shown as Candidate | null; // assigned in the stream callback
    if (!early || early.backendNodeId !== c.backendNodeId) {
      await announceTarget(tabId, c.backendNodeId);
      post({ type: "target", reqId });
    }

    const kind = parsed.kind as ActionKind;
    const label = parsed.label.trim() || c.name || c.role;
    const irreversible = parsed.irreversible || IRREVERSIBLE.test(label) || IRREVERSIBLE.test(c.name);
    pending.set(tabId, { reqId, url, candidate: c, kind, value: parsed.value, label });
    post({ type: "action", reqId, kind, label, value: parsed.value, irreversible });
    console.log(
      `[carat] action → [${c.n}] ${kind} ${c.role} "${c.name}"${parsed.value ? ` = "${parsed.value}"` : ""}` +
        `${irreversible ? " (irreversible)" : ""} · ${summary}`,
    );
  } catch (e) {
    if (controller.signal.aborted) return;
    console.error("[carat] action prediction failed:", e);
    post({ type: "clear", reqId });
  } finally {
    if (inflight.get(tabId) === controller) inflight.delete(tabId);
  }
}

export async function acceptAction(tabId: number, reqId: number): Promise<ActuateResult> {
  const p = pending.get(tabId);
  if (!p || p.reqId !== reqId) return { ok: false, reason: "That suggestion has expired." };
  pending.delete(tabId);
  const id = p.candidate.backendNodeId;
  try {
    switch (p.kind) {
      case "click": {
        const result = await click(tabId, id);
        // The click is synthetic, so the content script's (trusted-only) logger skips it.
        if (result.ok) appendHistory(tabId, `clicked ${p.candidate.role} "${p.candidate.name}"`, p.url);
        return result;
      }
      case "fill":
        // Plain text fields are filled by the content script (jump + ghost text);
        // this is for anything else it could not handle, which just gets focus.
        return await focus(tabId, id);
      case "select":
        return (await select(tabId, id, p.value)) ?? (await click(tabId, id));
    }
  } catch (e) {
    console.error("[carat] accept failed:", e);
    return { ok: false, reason: "The page changed underneath the suggestion." };
  }
}

export function dismissAction(tabId: number, reqId: number): void {
  const p = pending.get(tabId);
  if (!p || p.reqId !== reqId) return;
  pending.delete(tabId);
  dismissed.add(`${p.url}|${p.candidate.backendNodeId}`);
  appendHistory(tabId, `dismissed suggestion: ${p.kind} ${p.candidate.role} "${p.candidate.name}"`, p.url);
}
