import type { NextAction, NextActionRequest, OutlineControl } from '@carat/shared';
import { EAGERNESS } from '@carat/shared';
import type { NextOptions, Provider } from './provider';
import { buildJevRequest, NEXT_QUESTION, NONE, SCROLL, type JevRequest } from './jev/request';
import { choice, parseJevResponse, type Answers } from './jev/response';

export const JEV_MODEL = 'typesafe/jev';
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export interface JevOptions {
  accountId: string;
  apiToken: string;
  model?: string;
}

/**
 * TypeSafe Jev on Cloudflare Workers AI: a classifier, not a writer. It gets
 * one question — which of the numbered controls, or a scroll, or nothing, is
 * the next step — over the same notes and history the model sees, and its
 * calibrated probability becomes the action's confidence. It ranks; it never
 * invents a value, so a text field it picks is filled from the regex
 * candidate that goes with it, and a click is all it can say otherwise.
 *
 * An abort, an unreadable body or a Cloudflare error envelope resolves to
 * null; a transport or HTTP failure without an envelope rejects, so the
 * caller can tell "no" from "never reached".
 */
export class JevProvider implements Provider {
  readonly id = 'cloudflare' as const;

  constructor(
    readonly options: JevOptions,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async next(req: NextActionRequest, opts: NextOptions): Promise<NextAction | null> {
    if (opts.signal.aborted) return null;
    const built = buildJevRequest(req);
    if (!built) return null;

    let body: unknown;
    try {
      // Never call fetch as a method of `this`: Chrome throws Illegal invocation.
      const { fetchImpl } = this;
      const res = await fetchImpl(`${CLOUDFLARE_API}/accounts/${encodeURIComponent(this.options.accountId)}/ai/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiToken}` },
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
      if (opts.signal.aborted) return null;
      throw e;
    }

    const parsed = parseJevResponse(body);
    if (!parsed.ok) return null;
    return decide(built, parsed.answers, req);
  }
}

function isErrorEnvelope(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === false;
}

/** Jev is calibrated, so the chosen option's probability is the confidence as it stands. */
export function decide(built: JevRequest, answers: Answers, req: NextActionRequest): NextAction | null {
  const answer = choice(answers, NEXT_QUESTION);
  if (!answer || answer.choice === NONE) return null;
  const confidence = answer.probabilities[answer.choice] ?? answer.confidence;
  if (confidence < EAGERNESS[req.eagerness].minConfidence) return null;

  if (answer.choice === SCROLL) {
    if (!req.page.scroll.more) return null;
    return { kind: 'scroll', target: null, value: '', label: 'Scroll down', irreversible: false, confidence, reason: 'more of the page below' };
  }
  const option = built.options.find((o) => o.key === answer.choice);
  if (!option) return null;
  const { control } = option;
  return option.value
    ? fill(control, option.value, confidence)
    : {
        kind: 'click',
        target: control.n,
        value: '',
        label: `Click "${control.name}"`,
        irreversible: false,
        confidence,
        reason: option.reason,
      };
}

function fill(control: OutlineControl, value: string, confidence: number): NextAction {
  return {
    kind: 'fill',
    target: control.n,
    value,
    label: `Fill ${control.name} with "${value}"`,
    irreversible: false,
    confidence,
    reason: 'the value you read fits this field',
  };
}
