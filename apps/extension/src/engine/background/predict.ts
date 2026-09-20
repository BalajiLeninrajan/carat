/**
 * Next-action prediction for a tab: stream the model's answer, point the
 * content script at the target as soon as `target` has streamed, then send the
 * rest (kind, label, irreversible) once the JSON is complete. Also carries out
 * accepted actions and remembers dismissals.
 */

import { BROWSER_KINDS, UNTARGETED_KINDS, type ActionKind, type WorkerToContent } from "../shared/protocol";
import type { Settings } from "../shared/settings";
import { announceTarget, click, focus, pressEnter, select, type ActuateResult } from "./actuate";
import { browserContext, openOrSearch, switchToTab, type BrowserContext, type TabTarget } from "./browser";
import { appendHistory } from "./history";
import { partialAction, streamResponse } from "./llm";
import type { Candidate, Outline } from "./outline";
import { buildActionRequest, type ResponsesRequest } from "./prompts";

/** Labels that mean "this cannot be undone": two taps, whatever the model says. */
const IRREVERSIBLE = /\b(send|submit|pay|purchase|buy|order|place|checkout|delete|remove|discard|publish|post|confirm|transfer|sign ?out|log ?out|unsubscribe|cancel (my )?(subscription|order|account))\b/i;

interface Pending {
  reqId: number;
  url: string;
  /** The page control to act on; absent for browser actions. */
  candidate?: Candidate;
  /** The tab to switch to, for kind "switch". */
  tab?: TabTarget;
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
    const raw = (v[1] ?? "").replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, ""); // drop a half-written escape
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
  return { target: Number(target[1]), kind: kind[1] ?? "", value: value.trim(), label, irreversible };
}

/**
 * Ours: the debug panel's window onto one prediction. Both calls are made only
 * when the panel is open on the tab, so a closed panel costs one null check.
 */
export interface PredictionTrace {
  request(request: ResponsesRequest, candidates: number): void;
  answer(answer: {
    raw: string;
    kind: ActionKind | null;
    target: number | null;
    label: string;
    value: string;
    irreversible: boolean;
    ttftMs: number | null;
    targetMs: number | null;
    totalMs: number | null;
    usage: { input: number; cached: number; output: number } | null;
    outcome: string;
  }): void;
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
  /** Ours: the page continues below the viewport, which is what makes "scroll" a step. */
  below?: boolean;
  /** Ours: what the user has highlighted, which is usually what the next step is about. */
  selection?: string;
  /** Ours: the debug panel, when it is open on this tab. Nothing is built for it otherwise. */
  trace?: PredictionTrace;
  post: (msg: WorkerToContent) => void;
}): Promise<void> {
  const { tabId, reqId, url, settings, outline, notes, history, post } = opts;
  const browser: BrowserContext = await browserContext(tabId);
  cancelPrediction(tabId);
  pending.delete(tabId);
  const controller = new AbortController();
  inflight.set(tabId, controller);

  const request = buildActionRequest({ settings, url, outline: outline.text, notes, history, browser: browser.text, below: opts.below, selection: opts.selection });
  opts.trace?.request(request, outline.candidates.length);
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
        const { kind, target: n } = partialAction(json);
        // Browser actions have nothing on the page to ring, and their number
        // means a tab, not a control. Nor does a scroll, which is about the viewport.
        if (!kind || UNTARGETED_KINDS.includes(kind as ActionKind)) return;
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
        trace(opts, result, targetMs, null, "cleared: the model's output would not parse");
        post({ type: "clear", reqId });
        return;
      }
      parsed = salvaged;
      console.warn(`[carat] action: output was cut off; salvaged ${parsed.kind} [${parsed.target}] with a ${parsed.value.length}-char value`);
    }

    const summary =
      `ttft ${result.ttftMs}ms · target ${targetMs ?? "-"}ms · total ${result.totalMs}ms · ` +
      `${result.usage?.input ?? "?"} in (${result.usage?.cached ?? 0} cached) / ${result.usage?.output ?? "?"} out`;

    // One screen down. Nothing to ring and nothing for the worker to do: the
    // content script scrolls the page itself when the user takes it.
    if (parsed.kind === "scroll") {
      trace(opts, result, targetMs, parsed, "shown");
      pending.set(tabId, { reqId, url, kind: "scroll", value: "", label: parsed.label.trim() || "Read on" });
      post({ type: "action", reqId, kind: "scroll", label: parsed.label.trim() || "Read on", value: "", irreversible: false, browser: true });
      console.log(`[carat] action → scroll one screen · ${summary}`);
      return;
    }

    // Tab strip / address bar: nothing on the page to ring, so the chip floats.
    if (BROWSER_KINDS.includes(parsed.kind as ActionKind)) {
      const tab = parsed.kind === "switch" ? browser.tabs[parsed.target - 1] : undefined;
      if (parsed.kind === "switch" && !tab) {
        console.log(`[carat] action → no tab [T${parsed.target}] · ${summary}`);
        trace(opts, result, targetMs, parsed, `cleared: no tab [T${parsed.target}]`);
        post({ type: "clear", reqId });
        return;
      }
      const kind = parsed.kind as ActionKind;
      const label =
        parsed.label.trim() || (tab ? tab.title.slice(0, 40) : parsed.value);
      pending.set(tabId, { reqId, url, tab, kind, value: parsed.value, label });
      trace(opts, result, targetMs, parsed, "shown");
      post({ type: "action", reqId, kind, label, value: parsed.value, irreversible: false, browser: true });
      console.log(`[carat] action → ${kind} ${tab ? `tab "${tab.title}"` : `"${parsed.value}"`} · ${summary}`);
      return;
    }

    const c = candidateFor(parsed.target);
    if (!c) {
      console.log(`[carat] action → unusable target [${parsed.target}] (not on the page, or dismissed) · ${summary}`);
      trace(opts, result, targetMs, parsed, `cleared: [${parsed.target}] is not on the page, or was dismissed`);
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
    trace(opts, result, targetMs, { ...parsed, label, irreversible }, "shown");
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
  try {
    // The page scrolls itself; an accept that reaches here is one the content script could not carry out.
    if (p.kind === "scroll") return { ok: true };
    if (p.kind === "switch") return p.tab ? await switchToTab(p.tab) : { ok: false, reason: "That tab is gone." };
    if (p.kind === "open") return await openOrSearch(tabId, p.value);
    if (!p.candidate) return { ok: false, reason: "That suggestion has expired." };
    const id = p.candidate.backendNodeId;
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
      case "submit":
        return await pressEnter(tabId, id);
      default:
        return { ok: false, reason: "That suggestion is no longer valid." };
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
  if (p.candidate) dismissed.add(`${p.url}|${p.candidate.backendNodeId}`);
  appendHistory(
    tabId,
    `dismissed suggestion: ${p.kind} ${p.candidate ? `${p.candidate.role} "${p.candidate.name}"` : p.label}`,
    p.url,
  );
}

/** Ours: one line for the debug panel, only when it is open on this tab. */
function trace(
  opts: { trace?: PredictionTrace },
  result: { text: string; ttftMs: number | null; totalMs: number; usage: { input: number; cached: number; output: number } | null },
  targetMs: number | null,
  parsed: ParsedAction | null,
  outcome: string,
): void {
  opts.trace?.answer({
    raw: result.text,
    kind: (parsed?.kind as ActionKind | undefined) ?? null,
    target: parsed?.target ?? null,
    label: parsed?.label ?? "",
    value: parsed?.value ?? "",
    irreversible: parsed?.irreversible ?? false,
    ttftMs: result.ttftMs,
    targetMs,
    totalMs: result.totalMs,
    usage: result.usage,
    outcome,
  });
}
