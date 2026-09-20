/**
 * Streaming client for the OpenAI Responses API.
 *
 * Models differ in what they accept (reasoning effort levels, service tiers,
 * prompt_cache_key on some proxies). When the API rejects a parameter, the
 * error names it in `error.param`; we relax that parameter, remember the
 * fix for the model, and retry, so a model change is never more than a
 * settings edit.
 */

import type { Settings } from "../shared/settings.js";
import type { ResponsesRequest } from "./prompts.js";

export interface StreamResult {
  text: string;
  /** ms from request start to the first output token. */
  ttftMs: number | null;
  totalMs: number;
  usage: { input: number; cached: number; output: number } | null;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Body = ResponsesRequest & Record<string, unknown>;

/** Per model: how to adjust a request the model previously rejected. */
const fixes = new Map<string, ((body: Body) => void)[]>();

const EFFORT_FALLBACK: Record<string, string | null> = { none: "minimal", minimal: "low", low: null };

/** Relax the parameter named in an error. Returns false if there is nothing to relax. */
function relax(body: Body, param: string): ((b: Body) => void) | null {
  if (param.startsWith("reasoning")) {
    const next = body.reasoning ? EFFORT_FALLBACK[body.reasoning.effort] : null;
    return next ? (b) => b.reasoning && (b.reasoning = { effort: next }) : (b) => delete b.reasoning;
  }
  const top = param.split(".")[0];
  if (top in body && !["model", "input", "instructions"].includes(top)) return (b) => delete b[top];
  return null;
}

async function errorOf(res: Response): Promise<{ message: string; param?: string }> {
  try {
    const json = await res.json();
    return { message: json.error?.message ?? res.statusText, param: json.error?.param ?? undefined };
  } catch {
    return { message: res.statusText };
  }
}

export async function streamResponse(
  settings: Settings,
  request: ResponsesRequest,
  onDelta: (textSoFar: string) => void,
  signal: AbortSignal,
): Promise<StreamResult> {
  if (!settings.apiKey) throw new LlmError("No API key: set one in Carat's options page.");
  const started = performance.now();
  const body = structuredClone(request) as Body;
  for (const fix of fixes.get(body.model) ?? []) fix(body);

  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(`${settings.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) break;
    const err = await errorOf(res);
    const fix = res.status === 400 && err.param ? relax(body, err.param) : null;
    if (!fix) throw new LlmError(`${res.status}: ${err.message}`, res.status);
    console.info(`[carat] ${body.model} rejected "${err.param}", adjusting and retrying`);
    fix(body);
    fixes.set(body.model, [...(fixes.get(body.model) ?? []), fix]);
    res = null;
  }
  if (!res?.body) throw new LlmError("Request kept being rejected");

  let text = "";
  let ttftMs: number | null = null;
  let usage: StreamResult["usage"] = null;

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    // Server-sent events are separated by a blank line; each has one data: line here.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === "response.output_text.delta") {
        if (ttftMs == null) ttftMs = Math.round(performance.now() - started);
        text += event.delta;
        onDelta(text);
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        const u = event.response?.usage;
        if (u) {
          usage = {
            input: u.input_tokens ?? 0,
            cached: u.input_tokens_details?.cached_tokens ?? 0,
            output: u.output_tokens ?? 0,
          };
        }
      } else if (event.type === "response.failed" || event.type === "error") {
        const message = event.response?.error?.message ?? event.message ?? "stream failed";
        throw new LlmError(message);
      }
    }
  }
  return { text, ttftMs, totalMs: Math.round(performance.now() - started), usage };
}

/**
 * Pull kind and target out of partial JSON as soon as each is complete. They
 * are the first two fields, so a target can be ringed long before the rest of
 * the answer arrives — and kind says whether that number is a page control or
 * one of the browser targets.
 */
export function partialAction(json: string): { kind: string | null; target: number | null } {
  const kind = /"kind"\s*:\s*"(\w+)"/.exec(json);
  const target = /"target"\s*:\s*(-?\d+)\s*[,}]/.exec(json);
  return { kind: kind ? kind[1] : null, target: target ? Number(target[1]) : null };
}
