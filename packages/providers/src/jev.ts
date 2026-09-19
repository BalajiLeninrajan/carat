import type { FillSuggestion, SuggestRequest, Suggestion } from '@carat/shared';
import { LIMITS } from '@carat/shared';
import type { Provider } from './provider';
import { sameSite } from './same-site';
import { CANDIDATE_LABEL } from './local/candidates';
import { GATE_QUESTION, NONE, buildJevRequest, questionKey, sourceLabel, type JevRequest } from './jev/request';
import { choice, noul, parseJevResponse, type Answers } from './jev/response';

export const JEV_MODEL = 'typesafe/jev';
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** Below this, the request-level "is any of this relevant" answer says no and every field is skipped. */
export const GATE_MIN = 0.5;

export interface JevOptions {
  accountId: string;
  apiToken: string;
  model?: string;
}

/**
 * TypeSafe Jev on Cloudflare Workers AI: a classifier, not a writer. The regex
 * candidates are the only values it can return, so on a page with no
 * candidate it returns [] and the caller moves on to an LLM.
 *
 * Failure policy matches OpenAICompatProvider: an abort, a body we cannot
 * read, or a Cloudflare error envelope resolves to []; a transport or HTTP
 * failure without an envelope rejects so the caller can tell "no" from
 * "never reached".
 */
export class JevProvider implements Provider {
  readonly id = 'cloudflare' as const;

  constructor(
    readonly options: JevOptions,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async suggest(req: SuggestRequest, opts: { signal: AbortSignal }): Promise<Suggestion[]> {
    if (opts.signal.aborted) return [];
    const context = req.context.filter((c) => !sameSite(c.origin, req.page.host));
    const built = buildJevRequest(req, context);
    if (!built) return [];

    let body: unknown;
    try {
      // Never call fetch as a method of `this`: Chrome throws Illegal invocation.
      const { fetchImpl } = this;
      const res = await fetchImpl(`${CLOUDFLARE_API}/accounts/${encodeURIComponent(this.options.accountId)}/ai/run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiToken}`,
        },
        body: JSON.stringify({
          model: this.options.model ?? JEV_MODEL,
          input: { state: built.state, questions: built.questions },
        }),
        signal: opts.signal,
      });
      body = await res.json().catch(() => undefined);
      // Cloudflare reports bad input and bad tokens as 4xx with the same envelope.
      if (!res.ok && !isErrorEnvelope(body)) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (opts.signal.aborted) return [];
      throw e;
    }

    const parsed = parseJevResponse(body);
    if (!parsed.ok) return [];
    return decide(built, parsed.answers);
  }
}

function isErrorEnvelope(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === false;
}

/** Jev is calibrated, so the chosen option's probability is the confidence as-is. */
export function decide(built: JevRequest, answers: Answers): Suggestion[] {
  const gate = noul(answers, GATE_QUESTION);
  if (gate === null || gate < GATE_MIN) return [];

  const byKey = new Map(built.options.map((o) => [o.key, o]));
  const out: FillSuggestion[] = [];
  for (const field of built.askedFields) {
    const answer = choice(answers, questionKey(field.i));
    if (!answer || answer.choice === NONE) continue;
    const option = byKey.get(answer.choice);
    if (!option) continue;
    const confidence = answer.probabilities[answer.choice] ?? answer.confidence;
    if (confidence < LIMITS.minConfidence) continue;
    out.push({
      kind: 'fill',
      fieldId: field.i,
      value: option.candidate.value,
      confidence,
      reason: `${CANDIDATE_LABEL[option.candidate.kind]} in ${option.source.title || sourceLabel(option.source)}`,
      sourceContextId: option.source.id,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, LIMITS.maxSuggestions);
}
