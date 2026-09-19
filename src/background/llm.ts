import type { Settings } from "../shared/types.js";

/**
 * Minimal streaming OpenAI client.
 *
 * It speaks both /v1/responses and /v1/chat/completions, and quietly drops
 * request parameters the configured model rejects. That matters here because
 * the default model is configurable: a model that refuses `temperature` should
 * cost one retry, not a broken demo.
 */

export interface CompletionOptions {
  settings: Settings;
  system: string;
  user: string;
  singleLine: boolean;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  /** Ask for JSON matching this schema (structured output), where supported. */
  jsonSchema?: { name: string; schema: object };
  /** Overrides settings.maxOutputTokens for this request. */
  maxTokens?: number;
}

export class LlmError extends Error {
  readonly fatal: boolean;
  constructor(message: string, fatal = false) {
    super(message);
    this.name = "LlmError";
    this.fatal = fatal;
  }
}

/** Parameters a given model has already rejected, so we stop sending them. */
const droppedParams = new Map<string, Set<string>>();
/** Surface overrides learned at runtime when the configured one 404s. */
const surfaceOverride = new Map<string, "responses" | "chat">();

function dropped(model: string): Set<string> {
  let set = droppedParams.get(model);
  if (!set) {
    set = new Set();
    droppedParams.set(model, set);
  }
  return set;
}

function buildBody(
  api: "responses" | "chat",
  opts: CompletionOptions,
  skip: Set<string>,
): Record<string, unknown> {
  const { settings, system, user, singleLine, jsonSchema } = opts;
  const maxTokens = opts.maxTokens ?? settings.maxOutputTokens;
  const body: Record<string, unknown> = { model: settings.model, stream: true };

  if (api === "responses") {
    body.instructions = system;
    body.input = [{ role: "user", content: [{ type: "input_text", text: user }] }];
    if (!skip.has("max_output_tokens")) body.max_output_tokens = maxTokens;
    if (!skip.has("temperature")) body.temperature = 0.2;
    // Ghost text is a latency path - no reasoning at all. Models that do not
    // take this parameter drop it on the first 400 and never send it again.
    if (!skip.has("reasoning")) body.reasoning = { effort: "none" };
    if (jsonSchema && !skip.has("text")) {
      body.text = {
        format: { type: "json_schema", name: jsonSchema.name, schema: jsonSchema.schema, strict: true },
      };
    }
  } else {
    body.messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    if (!skip.has("max_completion_tokens")) body.max_completion_tokens = maxTokens;
    if (!skip.has("temperature")) body.temperature = 0.2;
    if (singleLine && !skip.has("stop")) body.stop = ["\n"];
    if (jsonSchema && !skip.has("response_format")) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: jsonSchema.name, schema: jsonSchema.schema, strict: true },
      };
    }
  }
  return body;
}

/**
 * Map an API complaint onto the parameter we should stop sending. The error's
 * own `param` field is authoritative when present ("reasoning.effort" -> drop
 * "reasoning"); the message scan is the fallback for APIs that omit it.
 */
function offendingParam(message: string, param?: string): string | null {
  if (param) return param.split(".")[0];
  const known = [
    "max_output_tokens",
    "max_completion_tokens",
    "max_tokens",
    "temperature",
    "reasoning",
    "response_format",
    "stop",
    "top_p",
  ];
  const lower = message.toLowerCase();
  if (!/unsupported|unrecognized|not supported|invalid|unknown parameter|does not support/.test(lower)) {
    return null;
  }
  return known.find((p) => lower.includes(p)) ?? null;
}

function extractDelta(event: Record<string, unknown>): string {
  // Responses API
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    return event.delta;
  }
  // Chat Completions
  const choices = event.choices as Array<Record<string, any>> | undefined;
  if (choices && choices.length) {
    const choice = choices[0];
    const content = choice.delta?.content ?? choice.text;
    if (typeof content === "string") return content;
  }
  return "";
}

async function readStream(
  response: Response,
  onDelta: (text: string) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new LlmError("Streaming response had no body");

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");

      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.type === "error" || event.error) {
          const err = (event.error ?? event) as { message?: string };
          throw new LlmError(err.message || "Stream error");
        }
        const delta = extractDelta(event);
        if (delta) {
          text += delta;
          onDelta(delta);
        }
      }
    }
  }
  return text;
}

async function attempt(
  api: "responses" | "chat",
  opts: CompletionOptions,
): Promise<string> {
  const { settings, signal } = opts;
  const skip = dropped(settings.model);
  const url = `${settings.baseUrl.replace(/\/$/, "")}/${api === "responses" ? "responses" : "chat/completions"}`;

  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(buildBody(api, opts, skip)),
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code = "";
    let param: string | undefined;
    try {
      const payload = (await response.json()) as {
        error?: { message?: string; code?: string; param?: string };
      };
      if (payload.error?.message) message = payload.error.message;
      code = payload.error?.code ?? "";
      param = payload.error?.param ?? undefined;
    } catch {
      /* non-JSON error body */
    }

    if (response.status === 401) {
      throw new LlmError("OpenAI rejected the API key - check it in Carat's options.", true);
    }
    if (response.status === 429) {
      throw new LlmError("Rate limited by OpenAI.");
    }

    const offender = offendingParam(message, param);
    if (offender && !skip.has(offender)) {
      skip.add(offender);
      return attempt(api, opts);
    }

    const modelMissing = code === "model_not_found" || /model/i.test(message) && response.status === 404;
    if (modelMissing) {
      throw new LlmError(
        `Model "${settings.model}" was not found. Set a different model in Carat's options.`,
        true,
      );
    }

    // The configured surface may simply not serve this model - try the other one once.
    const other = api === "responses" ? "chat" : "responses";
    if (response.status === 404 && surfaceOverride.get(settings.model) !== other) {
      surfaceOverride.set(settings.model, other);
      return attempt(other, opts);
    }

    throw new LlmError(message, response.status === 400);
  }

  return readStream(response, opts.onDelta);
}

export async function streamCompletion(opts: CompletionOptions): Promise<string> {
  if (!opts.settings.apiKey) {
    throw new LlmError("No OpenAI API key set - open Carat's options to add one.", true);
  }
  const api = surfaceOverride.get(opts.settings.model) ?? opts.settings.api;
  return attempt(api, opts);
}
