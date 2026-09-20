import type { ChatMessage, ImageInput, NextAction, NextActionRequest } from '@carat/shared';
import {
  DISTILL_RESPONSE_FORMAT,
  LIMITS,
  NEXT_ACTION_RESPONSE_FORMAT,
  TRANSCRIBE_PROMPT,
  buildGhostMessages,
  buildNextActionMessages,
  buildWarmupMessages,
  cleanGhost,
  distillMessages,
  fnv1a,
  normalizeWhitespace,
  parseNextAction,
  partialTarget,
  stripFences,
  truncate,
} from '@carat/shared';
import type { CompleteOptions, CompleteRequest, NextOptions, VisionProvider } from './provider';

export type OutputMode = 'json_schema' | 'json_object' | 'prompt';

/** OpenAI's `reasoning_effort` values that make sense here; the engine wants none, reading a screenshot a little. */
// 'none' is the no-reasoning value on GPT-5.1+; 'minimal' is rejected there.
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/**
 * Parameters a model rejected once, remembered so the next call leaves them
 * out. Backed by chrome.storage.local in the extension; an in-memory map
 * everywhere else.
 */
export interface RelaxStore {
  dropped(model: string): Promise<string[]>;
  drop(model: string, param: string): Promise<void>;
}

export function memoryRelaxStore(): RelaxStore {
  const seen = new Map<string, Set<string>>();
  return {
    async dropped(model) {
      return [...(seen.get(model) ?? [])];
    },
    async drop(model, param) {
      const set = seen.get(model) ?? new Set<string>();
      set.add(param);
      seen.set(model, set);
    },
  };
}

export interface OpenAICompatOptions {
  id: 'openai' | 'baseten';
  baseURL: string;
  apiKey: string;
  model: string;
  mode: OutputMode;
  /** Sent as `reasoning_effort` on every call when set. Left unset for servers that reject unknown parameters. */
  reasoningEffort?: ReasoningEffort;
  relaxStore?: RelaxStore;
  /** Cap on the action call's output; a long fill value is what spends it. */
  maxTokens?: number;
}

/** Parameters the request cannot do without, whatever the server says about them. */
const NEVER_DROP = new Set(['model', 'messages', 'stream']);
const NOTES_MAX_TOKENS = 300;
/** A warm-up wants the prompt read, not answered. */
const WARMUP_MAX_TOKENS = 1;

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
}

// Only `transcribe` sends parts; everything else stays on plain string content
// so a text-only server never sees an image_url it cannot handle.
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'low' | 'high' | 'auto' } };

interface PartsMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

export class OpenAICompatProvider implements VisionProvider {
  readonly id: 'openai' | 'baseten';
  private readonly relaxStore: RelaxStore;

  constructor(
    readonly options: OpenAICompatOptions,
    readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = options.id;
    this.relaxStore = options.relaxStore ?? memoryRelaxStore();
  }

  /**
   * One streamed action. The target reaches the caller through `onPartial`
   * as soon as the integer is closed, so the ring lands on the control while
   * the label is still being written; a body the output limit cut short is
   * salvaged rather than thrown away. An abort resolves to null; a transport
   * or HTTP failure rejects, so the caller can tell "the model said nothing"
   * from "the model was never reached".
   */
  async next(req: NextActionRequest, opts: NextOptions): Promise<NextAction | null> {
    if (opts.signal.aborted) return null;
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: buildNextActionMessages(req),
      stream: true,
      max_completion_tokens: this.options.maxTokens ?? 400,
      // Caching is per page, not per keystroke: everything before the outline is the same for this origin and path.
      prompt_cache_key: cacheKey(req.page.host, req.page.path),
      ...responseFormat(this.options.mode),
      ...this.reasoning(),
    };
    let announced = false;
    const text = await this.stream(body, opts.signal, (soFar) => {
      if (announced || !opts.onPartial) return;
      const target = partialTarget(soFar);
      if (target === null) return;
      announced = true;
      opts.onPartial({ target });
    });
    if (text === null) return null;
    // The body exactly as it streamed, before anything is made of it. Only the
    // debug panel asks for this, and only while it is open on the tab.
    opts.onRaw?.(text);
    const parsed = parseNextAction(text);
    return parsed.ok ? parsed.action : null;
  }

  /**
   * The ghost: a short continuation of what the user is typing, streamed as
   * plain text. No JSON mode and no reasoning, because the answer is a phrase
   * and the user is waiting on it mid-keystroke. `onDelta` sees the cleaned
   * text after every chunk, so the first token is grey on the page while the
   * rest is still being written. An abort, a refusal or a failure all resolve
   * to '': nothing to continue is a real answer here, and it hands Tab back
   * to the next-action path.
   */
  async complete(req: CompleteRequest, opts: CompleteOptions): Promise<string> {
    if (opts.signal.aborted) return '';
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: buildGhostMessages(req),
      stream: true,
      max_completion_tokens: req.maxTokens,
      ...(req.page ? { prompt_cache_key: cacheKey(req.page.host, req.page.path) } : {}),
      // A phrase in the user's own voice; thinking about it first only costs them the pause.
      ...(this.options.reasoningEffort ? { reasoning_effort: 'none' } : {}),
    };
    let shown = '';
    try {
      const text = await this.stream(body, opts.signal, (soFar) => {
        if (!opts.onDelta) return;
        const cleaned = cleanGhost(soFar, req.singleLine);
        if (cleaned === shown) return;
        shown = cleaned;
        opts.onDelta(cleaned);
      });
      return text === null ? '' : cleanGhost(text, req.singleLine);
    } catch {
      return '';
    }
  }

  /**
   * The same prompt the next real request will send, minus the outline, with
   * a one-token cap: the server reads the prefix, caches it under the page's
   * key, and the call that follows pays for the outline alone. The answer is
   * discarded and every failure is swallowed — a warm-up that does not happen
   * costs latency, never correctness. A 400 here does not teach the relax
   * store either, since the one-token cap is as likely a cause as the
   * parameter the server named.
   */
  async warm(req: NextActionRequest, opts: { signal: AbortSignal }): Promise<void> {
    if (opts.signal.aborted) return;
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: buildWarmupMessages(req),
      max_completion_tokens: WARMUP_MAX_TOKENS,
      // The same key the real request will use, or the prefix lands in a cache entry nothing reads.
      prompt_cache_key: cacheKey(req.page.host, req.page.path),
      ...responseFormat(this.options.mode),
      ...this.reasoning(),
    };
    for (const param of await this.relaxStore.dropped(this.options.model)) delete body[param];
    try {
      const res = await this.send(body, opts.signal);
      // Nothing here is read; release the connection rather than buffer a body we throw away.
      await res.body?.cancel();
    } catch {
      // Fire and forget.
    }
  }

  /**
   * The visible text of a screenshot plus a `Facts:` block, whitespace
   * collapsed and clipped. An abort or an empty reply is ''; transport and
   * HTTP failures reject.
   */
  async transcribe(image: ImageInput, opts: { signal: AbortSignal }): Promise<string> {
    if (opts.signal.aborted) return '';
    const messages: PartsMessage[] = [
      { role: 'system', content: TRANSCRIBE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Screenshot of the tab "${image.title}" on ${image.host}. now: ${image.now}` },
          // A thin-text page reads fine at the small rendering; a picture the user was
          // looking at (a poster, a map, a pasted screenshot) needs the full one.
          { type: 'image_url', image_url: { url: image.dataUrl, detail: image.cue === 'image-heavy' ? 'high' : 'low' } },
        ],
      },
    ];
    try {
      const content = await this.post({ model: this.options.model, messages, ...this.reasoning() }, opts.signal);
      if (typeof content !== 'string') return '';
      return truncate(normalizeWhitespace(content), LIMITS.pageTextChars);
    } catch (e) {
      if (opts.signal.aborted) return '';
      throw e;
    }
  }

  /**
   * The notes call: a page the user just left, down to at most five
   * self-contained facts. Small and thoughtless by design — it runs on every
   * tab switch — so no reasoning and a short output. Never rejects: notes are
   * a bonus, not a step in the chip's path.
   */
  async distill(text: string, host: string, signal: AbortSignal): Promise<string[]> {
    if (signal.aborted || text.trim().length < 40) return [];
    const body = {
      model: this.options.model,
      messages: distillMessages(text, host),
      max_completion_tokens: NOTES_MAX_TOKENS,
      ...(this.options.mode === 'json_schema' ? { response_format: DISTILL_RESPONSE_FORMAT } : { response_format: { type: 'json_object' } }),
      ...(this.options.reasoningEffort ? { reasoning_effort: 'none' } : {}),
    };
    try {
      const content = await this.post(body, signal);
      if (typeof content !== 'string') return [];
      const parsed = JSON.parse(stripFences(content)) as { notes?: unknown };
      if (!Array.isArray(parsed.notes)) return [];
      return parsed.notes
        .filter((n): n is string => typeof n === 'string')
        .map((n) => n.trim())
        .filter(Boolean)
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  private reasoning(): Record<string, unknown> {
    return this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {};
  }

  /**
   * A streamed chat completion, returning the whole text. `onDelta` sees the
   * text so far after every chunk. A parameter the server names in a 400 is
   * dropped and remembered for that model, then the call is retried, so a
   * model change is never more than a settings edit.
   */
  private async stream(body: Record<string, unknown>, signal: AbortSignal, onDelta: (soFar: string) => void): Promise<string | null> {
    if (signal.aborted) return null;
    const request = { ...body };
    for (const param of await this.relaxStore.dropped(this.options.model)) delete request[param];

    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await this.send(request, signal);
      } catch (e) {
        if (signal.aborted) return null;
        throw e;
      }
      if (res.ok) return await readStream(res, onDelta);
      const { message, param } = await errorOf(res);
      // Servers that reject `reasoning_effort`, `prompt_cache_key` or a streamed
      // `response_format` often name it in the prose and leave `error.param` empty.
      const drop = param ?? paramFromMessage(message, request);
      if (res.status !== 400 || !drop || !this.canDrop(request, drop)) throw new Error(`HTTP ${res.status}: ${message}`);
      delete request[drop];
      await this.relaxStore.drop(this.options.model, drop);
    }
    throw new Error('the model kept rejecting the request');
  }

  private canDrop(body: Record<string, unknown>, param: string): boolean {
    const top = param.split('.')[0]!;
    return top in body && !NEVER_DROP.has(top);
  }

  /** One non-streamed chat completion; resolves to the first choice's raw content. */
  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const res = await this.send(body, signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const completion = (await res.json()) as ChatCompletion;
    return completion.choices?.[0]?.message?.content;
  }

  private send(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    // Chrome's fetch throws "Illegal invocation" when called with a non-global
    // `this`, so never invoke it as this.fetchImpl(...).
    const { fetchImpl } = this;
    return fetchImpl(`${this.options.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  }
}

/** `carat-<hash of origin and path>`: one cache entry per page, shared by every visit to it. */
export function cacheKey(host: string, path: string): string {
  return `carat-${fnv1a(`https://${host}${path}`).toString(36)}`;
}

function responseFormat(mode: OutputMode): Record<string, unknown> {
  switch (mode) {
    case 'json_schema':
      return { response_format: NEXT_ACTION_RESPONSE_FORMAT };
    case 'json_object':
      return { response_format: { type: 'json_object' } };
    case 'prompt':
      return {};
  }
}

/**
 * The parameter a 400 is about when the server did not put it in
 * `error.param`. Only a key the request actually carries counts, and only one
 * the request can do without, so a message that happens to mention "model" or
 * "messages" never strips the call of what it is. The longest match wins, so
 * "response_format" is not read as "format".
 */
export function paramFromMessage(message: string, body: Record<string, unknown>): string | undefined {
  const text = message.toLowerCase();
  return Object.keys(body)
    .filter((k) => !NEVER_DROP.has(k))
    .sort((a, b) => b.length - a.length)
    .find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
}

async function errorOf(res: Response): Promise<{ message: string; param?: string }> {
  try {
    const json = (await res.json()) as { error?: { message?: string; param?: string } };
    return { message: json.error?.message ?? res.statusText, param: json.error?.param ?? undefined };
  } catch {
    return { message: res.statusText };
  }
}

/**
 * Server-sent events from a chat completion, folded into the text so far. A
 * server that answers a `stream: true` request with a whole completion (some
 * proxies do) is read as one.
 */
export async function readStream(res: Response, onDelta: (soFar: string) => void): Promise<string> {
  const body = res.body;
  if (!body) {
    const whole = (await res.json()) as ChatCompletion;
    const content = whole.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : '';
    if (text) onDelta(text);
    return text;
  }
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      let event: { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue;
      }
      const piece = event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.message?.content;
      if (typeof piece !== 'string' || piece === '') continue;
      text += piece;
      onDelta(text);
    }
  }
  return text;
}
