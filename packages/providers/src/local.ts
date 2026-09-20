import type { NextAction, NextActionRequest, OutlineControl } from '@carat/shared';
import { EAGERNESS, normalizeWhitespace } from '@carat/shared';
import type { NextOptions, Provider } from './provider';
import { CANDIDATE_LABEL, extractCandidates, notesAsSources, type Candidate, type CandidateKind } from './local/candidates';

/** Roles a typed value can go into. */
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/** What the placeholder is worth: enough for the eager floor, never enough to outrank the model on its own. */
export const PLACEHOLDER_CONFIDENCE = 0.5;

export const NO_ACTION: NextAction = {
  kind: 'none',
  target: null,
  value: '',
  label: '',
  irreversible: false,
  confidence: 0,
  reason: 'nothing the regexes could match',
};

/**
 * The instant answer, with no network behind it: a value the regexes found in
 * the notes, dropped into the focused text control or the first empty one.
 * There are no page-kind rules here and no priors — that is the model's job
 * now. Anything this cannot answer is `none`, and the chip waits for the
 * model instead.
 */
export class LocalProvider implements Provider {
  readonly id = 'local' as const;

  async next(req: NextActionRequest, opts: NextOptions): Promise<NextAction | null> {
    if (opts.signal.aborted) return null;
    return localAction(req);
  }
}

export function localAction(req: NextActionRequest): NextAction {
  const control = fillTarget(req);
  if (!control) return NO_ACTION;
  const loose = EAGERNESS[req.eagerness].looseNames;
  const candidates = extractCandidates(notesAsSources(req.notes), loose);
  const picked = candidates.find((c) => fits(c, control) && !echoes(c.value, control));
  if (!picked) return NO_ACTION;
  return {
    kind: 'fill',
    target: control.n,
    value: picked.value,
    label: `Fill ${control.name} with "${picked.value}"`,
    irreversible: false,
    confidence: PLACEHOLDER_CONFIDENCE,
    reason: `${CANDIDATE_LABEL[picked.kind]} from what you read`,
  };
}

/** Nothing a regex found goes into a field that asks for a secret or a payment detail. */
const SENSITIVE = /\b(card|cvv|cvc|cvn|expiry|expiration|password|passcode|pin|ssn|sin|security|account number|routing)\b/i;

/** The focused text control when it is empty, else the first empty one in the outline. */
function fillTarget(req: NextActionRequest): OutlineControl | undefined {
  const empty = (c: OutlineControl): boolean =>
    TEXT_ROLES.has(c.role) &&
    !c.value &&
    !c.risky &&
    !SENSITIVE.test(c.name) &&
    !/\bdisabled\b/.test(c.state ?? '') &&
    !sourceSearchControl(req, c);
  const focused = req.controls.find((c) => c.n === req.focused);
  if (focused && empty(focused)) return focused;
  return req.controls.find(empty);
}

function sourceSearchControl(req: NextActionRequest, control: OutlineControl): boolean {
  if (control.role !== 'searchbox') return false;
  if (!/\b(search|find|filter)\b/i.test(control.name)) return false;
  return /(^|\.)discord\.com$|(^|\.)slack\.com$|(^|\.)teams\.microsoft\.com$/i.test(req.page.host);
}

/** Cues in a control's name that say what kind of value belongs in it. */
const CUES: Array<{ kinds: CandidateKind[]; re: RegExp }> = [
  { kinds: ['email'], re: /\b(e-?mail|recipient|to|cc|bcc)\b/i },
  { kinds: ['phone'], re: /\b(phone|mobile|tel|telephone)\b/i },
  { kinds: ['address'], re: /\b(address|location|where|street|destination)\b/i },
  { kinds: ['plan', 'event', 'place', 'name'], re: /\b(title|summary|event|subject|name)\b/i },
  { kinds: ['place', 'name', 'event'], re: /\b(search|find|query|look ?up|maps?)\b/i },
];

function fits(candidate: Candidate, control: OutlineControl): boolean {
  const name = `${control.name} ${control.state ?? ''}`;
  for (const cue of CUES) {
    if (cue.re.test(name)) return cue.kinds.includes(candidate.kind);
  }
  // No cue at all: a search box takes a place or a name, anything else waits for the model.
  return control.role === 'searchbox' && ['place', 'plan', 'event', 'name'].includes(candidate.kind);
}

/** A field never gets its own label, placeholder or current value typed back into it. */
function echoes(value: string, control: OutlineControl): boolean {
  const v = normalizeWhitespace(value).toLowerCase();
  if (v.length < 2) return true;
  return [control.name, control.value].some((t) => t && normalizeWhitespace(t).toLowerCase() === v);
}
