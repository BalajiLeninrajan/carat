import type { ChatMessage, ClickGate, Eagerness, ElementDescriptor, ImageInput, InteractSuggestion, SuggestRequest, Suggestion } from '@carat/shared';
import {
  DEFAULT_EAGERNESS,
  EAGERNESS,
  LIMITS,
  PAGE_SOURCE,
  SUGGESTION_RESPONSE_FORMAT,
  SuggestionListSchema,
  TRANSCRIBE_PROMPT,
  buildMessages,
  clickAllowed,
  isDestructiveName,
  isIntentDestination,
  isPageScroll,
  normalizeWhitespace,
  pageJustifies,
  refusesFill,
  truncate,
  verbFits,
  weakBelow,
} from '@carat/shared';
import type { SuggestOptions, VisionProvider } from './provider';
import { sameSite } from './same-site';

export type OutputMode = 'json_schema' | 'json_object' | 'prompt';

/** OpenAI's `reasoning_effort` values that make sense here; the fast path wants none, the smart path a little. */
// 'none' is the no-reasoning value on GPT-5.1+; 'minimal' is rejected there.
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface OpenAICompatOptions {
  id: 'openai' | 'baseten';
  baseURL: string;
  apiKey: string;
  model: string;
  mode: OutputMode;
  /** Sent as `reasoning_effort` on every call when set. Left unset for servers that reject unknown parameters. */
  reasoningEffort?: ReasoningEffort;
  /** Picks the prompt's last rule and the confidence floor. Defaults to the product default. */
  eagerness?: Eagerness;
}

type Parsed = { ok: true; suggestions: Suggestion[] } | { ok: false; error: string };

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
}

// Only `transcribe` sends parts; `suggest` stays on plain string content so a
// text-only server (or provider) never sees an image_url it cannot handle.
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'low' | 'high' | 'auto' } };

interface PartsMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

export class OpenAICompatProvider implements VisionProvider {
  readonly id: 'openai' | 'baseten';

  constructor(
    readonly options: OpenAICompatOptions,
    readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.id = options.id;
  }

  // An unparseable reply (twice in a row) or an abort is "nothing to suggest"
  // and resolves to []. A transport or HTTP failure rejects so the caller can
  // tell "the model said no" from "the model was never reached" and fall back.
  async suggest(req: SuggestRequest, opts: SuggestOptions): Promise<Suggestion[]> {
    if (opts.signal.aborted) return [];
    const eagerness = this.options.eagerness ?? DEFAULT_EAGERNESS;
    const messages = buildMessages(req, eagerness);
    try {
      const first = await this.complete(messages, opts.signal);
      if (first.ok) return finalize(first.suggestions, req, eagerness, opts.onUnderFloor);
      if (opts.signal.aborted) return [];
      const second = await this.complete(withParseError(messages, first.error), opts.signal);
      return second.ok ? finalize(second.suggestions, req, eagerness, opts.onUnderFloor) : [];
    } catch (e) {
      if (opts.signal.aborted) return [];
      throw e;
    }
  }

  /**
   * The visible text of a screenshot plus a `Facts:` block (dates resolved
   * against `image.now`, places, addresses, people, prices, what any inner
   * image shows), whitespace-collapsed and clipped to a page item's length.
   * An abort or an empty reply is '' (nothing to store); transport and HTTP
   * failures reject like `suggest`.
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

  private async complete(messages: ChatMessage[], signal: AbortSignal): Promise<Parsed> {
    const body = { model: this.options.model, messages, ...responseFormat(this.options.mode), ...this.reasoning() };
    return parseContent(await this.post(body, signal));
  }

  private reasoning(): Record<string, unknown> {
    return this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {};
  }

  /** One chat completion; resolves to the first choice's raw content. */
  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    // Chrome's fetch throws "Illegal invocation" when called with a non-global
    // `this`, so never invoke it as this.fetchImpl(...).
    const { fetchImpl } = this;
    const res = await fetchImpl(`${this.options.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const completion = (await res.json()) as ChatCompletion;
    return completion.choices?.[0]?.message?.content;
  }
}

function responseFormat(mode: OutputMode): Record<string, unknown> {
  switch (mode) {
    case 'json_schema':
      return { response_format: SUGGESTION_RESPONSE_FORMAT };
    case 'json_object':
      return { response_format: { type: 'json_object' } };
    case 'prompt':
      return {};
  }
}

function parseContent(content: unknown): Parsed {
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, error: 'the reply had no text content' };
  }
  let data: unknown;
  try {
    data = JSON.parse(stripFences(content));
  } catch (e) {
    return { ok: false, error: `invalid JSON (${(e as Error).message})` };
  }
  // Models in json_object/prompt mode sometimes return the bare list.
  const result = SuggestionListSchema.safeParse(Array.isArray(data) ? { suggestions: data } : data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`);
    return { ok: false, error: `schema mismatch (${issues.join('; ')})` };
  }
  return { ok: true, suggestions: result.data.suggestions };
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1]! : t;
}

function withParseError(messages: ChatMessage[], error: string): ChatMessage[] {
  const last = messages[messages.length - 1]!;
  const note = `\n\nYour previous reply was rejected: ${error}. Reply again with only the JSON object described above.`;
  return [...messages.slice(0, -1), { role: last.role, content: last.content + note }];
}

function finalize(suggestions: Suggestion[], req: SuggestRequest, eagerness: Eagerness, onUnderFloor?: (s: Suggestion) => void): Suggestion[] {
  const knobs = EAGERNESS[eagerness];
  const fillable = new Set(req.fields.filter((f) => !f.v).map((f) => f.i));
  // Real context ids are never the few-shots' c1/c2/o1, so an unknown source
  // means the model echoed an example. The orchestrator never lists the
  // requesting tab's own text under `context`, so a same-site source here is
  // another tab on the site: shut out below eager, allowed at eager.
  const foreign = new Set(
    req.context.filter((c) => knobs.sameOriginContext || !sameSite(c.origin, req.page.host)).map((c) => c.id),
  );
  // The page the user is looking at is a fill source too, guarded by `refusesFill` below.
  const actionSources = new Set((req.own ?? []).map((c) => c.id));
  const fillSources = new Set([...foreign, ...actionSources]);
  const filled = req.filled ?? [];
  const interactSources = new Set([...fillSources, ...filled]);
  const fields = new Map(req.fields.map((f) => [f.i, f] as const));
  const elements = new Map((req.elements ?? []).map((e) => [e.i, e] as const));
  const here = `https://${req.page.host}${req.page.path}`;
  const gate: ClickGate = { filled: filled.length > 0, flow: req.flow === true, eagerness, fillable: fillable.size > 0 };
  // One winner per field, per element and per intent.
  const best = new Map<string, Suggestion>();
  for (const s of suggestions) {
    if (s.kind === 'fill') {
      if (!fillable.has(s.fieldId) || !fillSources.has(s.sourceContextId)) continue;
      if (refusesFill(s.value, fields.get(s.fieldId) ?? {}, req.page, actionSources.has(s.sourceContextId))) continue;
    }
    if (s.kind === 'action' && (!actionSources.has(s.sourceContextId) || isIntentDestination(s.intent, here))) continue;
    if (s.kind === 'interact' && !interactionAllowed(s, elements.get(s.elementId), interactSources, gate, req)) continue;
    // Checked last, so what is counted here would have shown at a looser level.
    if (s.confidence < knobs.minConfidence) {
      onUnderFloor?.(s);
      continue;
    }
    const key = s.kind === 'fill' ? `f:${s.fieldId}` : s.kind === 'interact' ? `e:${s.elementId || 'page'}` : `a:${s.intent}`;
    const prev = best.get(key);
    if (!prev || s.confidence > prev.confidence) best.set(key, { ...s, value: s.value.trim() });
  }
  // Every suggestion carries a value except a bare scroll. A page scroll yields to any surer fill or click on offer.
  const kept = [...best.values()].filter((s) => s.value !== '' || (s.kind === 'interact' && s.verb === 'scroll'));
  const better = kept.some((s) => !(s.kind === 'interact' && isPageScroll(s)) && s.kind !== 'action' && s.confidence >= weakBelow(eagerness));
  return kept.filter((s) => !(s.kind === 'interact' && isPageScroll(s)) || !better).sort((a, b) => b.confidence - a.confidence);
}

/**
 * An interaction names a described element, a verb that fits its role and
 * state, and a source the user read. A click on a button or link only stands
 * once carat filled something on the page, when it is the primary action and
 * a flow or the level lets that through (`clickAllowed`), or when the page
 * state itself justifies it (a results page's link, a filled-in checkout's
 * Continue); the model does not get to press other buttons on a page it
 * merely looked at. A `page`-sourced suggestion has to pass that same test,
 * whatever it is. Destructive names never pass, even if the content script
 * somehow described one. A page scroll names no element and stands only while
 * the page has more below and was not just scrolled. The service worker
 * applies the money rule; the provider has no settings.
 */
function interactionAllowed(
  s: InteractSuggestion,
  element: ElementDescriptor | undefined,
  sources: Set<string>,
  gate: ClickGate,
  req: SuggestRequest,
): boolean {
  if (isPageScroll(s)) return pageJustifies('scroll', undefined, req.state, req.fields);
  if (!element) return false;
  if (isDestructiveName(element.nm)) return false;
  if (!verbFits(element, s.verb, s.value.trim())) return false;
  if (s.sourceContextId === PAGE_SOURCE) return pageJustifies(s.verb, element, req.state, req.fields);
  if (!sources.has(s.sourceContextId)) return false;
  // Not cited to the page, so the ordinary click gate decides; the page state is the last word either way.
  if (s.verb === 'click' && !clickAllowed(element, gate)) return pageJustifies('click', element, req.state, req.fields);
  return true;
}
