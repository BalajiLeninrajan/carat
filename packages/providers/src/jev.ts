import type { Eagerness, EagernessKnobs, FillSuggestion, InteractSuggestion, SuggestRequest, Suggestion } from '@carat/shared';
import { DEFAULT_EAGERNESS, EAGERNESS, refusesFill, verbFits } from '@carat/shared';
import type { Provider, SuggestOptions } from './provider';
import { sameSite } from './same-site';
import { CANDIDATE_LABEL } from './local/candidates';
import { GATE_QUESTION, INTERACT_QUESTION, NEXT_QUESTION, NONE, buildJevRequest, questionKey, sourceLabel, type JevRequest } from './jev/request';
import { choice, noul, parseJevResponse, type Answers } from './jev/response';

export const JEV_MODEL = 'typesafe/jev';
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export interface JevOptions {
  accountId: string;
  apiToken: string;
  model?: string;
  /** Sets the `relevant` gate, the choice floor, the per-answer cap and the candidate set. Defaults to the product default. */
  eagerness?: Eagerness;
}

/**
 * TypeSafe Jev on Cloudflare Workers AI: a classifier, not a writer. The regex
 * candidates are the only fill values it can return, and a click, check or
 * uncheck on a described element is the only interaction. On a page with
 * neither it returns [] and the caller moves on to an LLM. Actions (open Maps,
 * Calendar, Gmail) are never asked about; those stay with the other providers.
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

  async suggest(req: SuggestRequest, opts: SuggestOptions): Promise<Suggestion[]> {
    if (opts.signal.aborted) return [];
    const eagerness = this.options.eagerness ?? DEFAULT_EAGERNESS;
    const foreign = EAGERNESS[eagerness].sameOriginContext ? req.context : req.context.filter((c) => !sameSite(c.origin, req.page.host));
    // The page the user is looking at goes first: its text is the likeliest answer to a field on it.
    const built = buildJevRequest(req, [...(req.own ?? []), ...foreign], eagerness);
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
    return decide(built, parsed.answers, eagerness, opts.onUnderFloor);
  }
}

function isErrorEnvelope(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === false;
}

type Drop = ((s: Suggestion) => void) | undefined;

/**
 * Jev is calibrated, so the chosen option's probability is the confidence
 * as-is. The `relevant` gate covers the fills only; the interaction and
 * next-step questions gate themselves with `none`. All thresholds come from
 * the eagerness table.
 */
export function decide(built: JevRequest, answers: Answers, eagerness: Eagerness = DEFAULT_EAGERNESS, onUnderFloor?: Drop): Suggestion[] {
  const knobs = EAGERNESS[eagerness];
  return [...fills(built, answers, knobs, onUnderFloor), ...interaction(built, answers, knobs, onUnderFloor), ...next(built, answers, knobs, onUnderFloor)];
}

/** The next-step pick, with Jev's probability as its confidence; under the level's choice floor it is dropped and counted. */
function next(built: JevRequest, answers: Answers, knobs: EagernessKnobs, onUnderFloor: Drop): Suggestion[] {
  if (built.nextOptions.length === 0) return [];
  const answer = choice(answers, NEXT_QUESTION);
  if (!answer || answer.choice === NONE) return [];
  const option = built.nextOptions.find((o) => o.key === answer.choice);
  if (!option) return [];
  const confidence = answer.probabilities[answer.choice] ?? answer.confidence;
  const picked: Suggestion = { ...option.suggestion, confidence, reason: option.because };
  if (confidence < knobs.minConfidence) {
    onUnderFloor?.(picked);
    return [];
  }
  return [picked];
}

function fills(built: JevRequest, answers: Answers, knobs: EagernessKnobs, onUnderFloor: Drop): FillSuggestion[] {
  if (built.askedFields.length === 0 || built.options.length === 0) return [];
  const gate = noul(answers, GATE_QUESTION);
  if (gate === null || gate < knobs.jevGateMin) return [];

  const byKey = new Map(built.options.map((o) => [o.key, o]));
  const out: FillSuggestion[] = [];
  for (const field of built.askedFields) {
    const answer = choice(answers, questionKey(field.i));
    if (!answer || answer.choice === NONE) continue;
    const option = byKey.get(answer.choice);
    if (!option) continue;
    const confidence = answer.probabilities[answer.choice] ?? answer.confidence;
    const fill: FillSuggestion = {
      kind: 'fill',
      fieldId: field.i,
      value: option.candidate.value,
      confidence,
      reason: `${CANDIDATE_LABEL[option.candidate.kind]} in ${option.source.title || sourceLabel(option.source)}`,
      sourceContextId: option.source.id,
    };
    // A candidate read off the page being filled must not be that page's own furniture.
    if (refusesFill(fill.value, field, built.page, built.ownIds.has(option.source.id))) continue;
    if (confidence < knobs.minConfidence) {
      onUnderFloor?.(fill);
      continue;
    }
    out.push(fill);
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, knobs.maxSuggestions);
}

function interaction(built: JevRequest, answers: Answers, knobs: EagernessKnobs, onUnderFloor: Drop): InteractSuggestion[] {
  if (built.interactOptions.length === 0) return [];
  const answer = choice(answers, INTERACT_QUESTION);
  if (!answer || answer.choice === NONE) return [];
  const option = built.interactOptions.find((o) => o.key === answer.choice);
  if (!option) return [];
  const confidence = answer.probabilities[answer.choice] ?? answer.confidence;
  const { element, verb } = option;
  if (!verbFits(element, verb, element.nm)) return [];
  const interact: InteractSuggestion = { kind: 'interact', elementId: element.i, verb, value: element.nm, confidence, reason: option.reason, sourceContextId: option.sourceContextId };
  if (confidence < knobs.minConfidence) {
    onUnderFloor?.(interact);
    return [];
  }
  return [interact];
}
