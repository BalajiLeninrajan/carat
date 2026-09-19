import type { ChatMessage, ElementDescriptor, InteractSuggestion, SuggestRequest, Suggestion } from '@carat/shared';
import { LIMITS, SUGGESTION_RESPONSE_FORMAT, SuggestionListSchema, buildMessages, isDestructiveName, isIntentDestination, verbFits } from '@carat/shared';
import type { Provider } from './provider';
import { sameSite } from './same-site';

export type OutputMode = 'json_schema' | 'json_object' | 'prompt';

export interface OpenAICompatOptions {
  id: 'openai' | 'baseten';
  baseURL: string;
  apiKey: string;
  model: string;
  mode: OutputMode;
}

type Parsed = { ok: true; suggestions: Suggestion[] } | { ok: false; error: string };

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export class OpenAICompatProvider implements Provider {
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
  async suggest(req: SuggestRequest, opts: { signal: AbortSignal }): Promise<Suggestion[]> {
    if (opts.signal.aborted) return [];
    const messages = buildMessages(req);
    try {
      const first = await this.complete(messages, opts.signal);
      if (first.ok) return finalize(first.suggestions, req);
      if (opts.signal.aborted) return [];
      const second = await this.complete(withParseError(messages, first.error), opts.signal);
      return second.ok ? finalize(second.suggestions, req) : [];
    } catch (e) {
      if (opts.signal.aborted) return [];
      throw e;
    }
  }

  private async complete(messages: ChatMessage[], signal: AbortSignal): Promise<Parsed> {
    // Chrome's fetch throws "Illegal invocation" when called with a non-global
    // `this`, so never invoke it as this.fetchImpl(...).
    const { fetchImpl } = this;
    const res = await fetchImpl(`${this.options.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({ model: this.options.model, messages, ...responseFormat(this.options.mode) }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const completion = (await res.json()) as ChatCompletion;
    return parseContent(completion.choices?.[0]?.message?.content);
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

function finalize(suggestions: Suggestion[], req: SuggestRequest): Suggestion[] {
  const fillable = new Set(req.fields.filter((f) => !f.v).map((f) => f.i));
  // Real context ids are never the few-shots' c1/c2/o1, so an unknown source
  // means the model echoed an example; a same-site fill source breaks rule 7.
  const fillSources = new Set(req.context.filter((c) => !sameSite(c.origin, req.page.host)).map((c) => c.id));
  const actionSources = new Set((req.own ?? []).map((c) => c.id));
  const filled = req.filled ?? [];
  const interactSources = new Set([...fillSources, ...filled]);
  const elements = new Map((req.elements ?? []).map((e) => [e.i, e] as const));
  const here = `https://${req.page.host}${req.page.path}`;
  // One winner per field, per element and per intent.
  const best = new Map<string, Suggestion>();
  for (const s of suggestions) {
    if (s.confidence < LIMITS.minConfidence) continue;
    if (s.kind === 'fill' && (!fillable.has(s.fieldId) || !fillSources.has(s.sourceContextId))) continue;
    if (s.kind === 'action' && (!actionSources.has(s.sourceContextId) || isIntentDestination(s.intent, here))) continue;
    if (s.kind === 'interact' && !interactionAllowed(s, elements.get(s.elementId), interactSources, filled.length > 0)) continue;
    const key = s.kind === 'fill' ? `f:${s.fieldId}` : s.kind === 'interact' ? `e:${s.elementId}` : `a:${s.intent}`;
    const prev = best.get(key);
    if (!prev || s.confidence > prev.confidence) best.set(key, { ...s, value: s.value.trim() });
  }
  return [...best.values()]
    .filter((s) => s.value !== '')
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * An interaction names a described element, a verb that fits its role and
 * state, and a source the user read. A click on a button or link only stands
 * once carat filled something on the page; the model does not get to press
 * buttons on a page it merely looked at. Destructive names never pass, even
 * if the content script somehow described one.
 */
function interactionAllowed(
  s: InteractSuggestion,
  element: ElementDescriptor | undefined,
  sources: Set<string>,
  filledSomething: boolean,
): boolean {
  if (!element || !sources.has(s.sourceContextId)) return false;
  if (isDestructiveName(element.nm)) return false;
  if (!verbFits(element, s.verb, s.value.trim())) return false;
  if (s.verb === 'click' && (element.r === 'button' || element.r === 'link') && !filledSomething) return false;
  return true;
}
