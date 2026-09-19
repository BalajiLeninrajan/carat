import type { ClickGate, ElementDescriptor, InteractSuggestion, RequestContext } from '@carat/shared';
import { clickAllowed, isDestructiveName, isPrimaryActionName, verbFits } from '@carat/shared';

const CONFIDENCE = 0.75;
// A primary button pressed with no fill behind it is a guess about where the user is heading: under the balanced floor.
const PRIMARY_CONFIDENCE = 0.5;

// Buttons that commit what was just typed: one verb, at most one object word.
// "Save & close" and "Save and continue" do a second thing and are not offered offline.
const COMMIT_NAME = /^(?:save|create|done|apply)(?:\s+(?!and\b|close\b|exit\b)[a-z]+)?$/i;

// Checkbox names too generic to match a sentence on: "Yes" or "Other" show up in any text.
const GENERIC_NAMES = new Set(['yes', 'no', 'ok', 'all', 'other', 'none', 'select all', 'remember me', 'i agree', 'agree', 'accept', 'subscribe']);
const MIN_NAME_CHARS = 4;

// "not a vegetarian", "no longer vegetarian", "don't ...". Judged on the 24 chars before the name.
const NEGATION = /\b(?:not|no|never|n't|neither|nor|without|isn|aren|don|doesn|didn|won|wouldn|can't|cannot)\b[^.?!]{0,16}$/i;
// "turn the volume to 40%", "volume at 40", "set volume: 40". Judged on the 24 chars after the name.
const AMOUNT_AFTER = /^[^.?!\n]{0,20}?\b(?:to|at|=|:)\s*(-?\d+(?:\.\d+)?)\s*(%?)/i;
// "40% volume". Judged on the 12 chars before the name.
const AMOUNT_BEFORE = /(-?\d+(?:\.\d+)?)\s*(%)\s*$/;

type Ctx = RequestContext[number];

/** What the regex provider needs besides the elements to decide about a button. */
export interface InteractInput {
  filled: string[];
  /** The rest of the click gate: the level, whether a flow is on, whether the page still has an empty field. */
  gate: Omit<ClickGate, 'filled'>;
}

/**
 * Offline interactions, all narrow. A Save-like button is offered only after
 * carat itself filled fields on the page (`filled`). The page's primary
 * continue-style button (Search, Continue, Next) is offered without a fill
 * only where `clickAllowed` says so: a flow, or the eager level with nothing
 * left to fill, at a confidence that says it is a guess. A checkbox, switch
 * or radio is offered when a context sentence contains its name unnegated.
 * A slider is offered when a context sentence names it with a number.
 * Nothing else is clicked: a missed chip costs nothing, a wrong click costs
 * trust. Money controls (`m: 1`) are never clicked offline.
 */
export function interactions(elements: ElementDescriptor[], context: Ctx[], input: InteractInput): InteractSuggestion[] {
  const { filled } = input;
  const out: InteractSuggestion[] = [];
  const safe = elements.filter((e) => !isDestructiveName(e.nm) && e.m !== 1);

  const commit = filled[0];
  if (commit !== undefined) {
    const candidates = safe.filter((e) => (e.r === 'button' || e.r === 'link') && COMMIT_NAME.test(e.nm.trim()));
    const button = candidates.find((e) => e.p === 1) ?? candidates[0];
    if (button) out.push(suggest(button, 'click', button.nm, commit, 'carat just filled fields on this page; this button commits them'));
  } else if (context[0]) {
    const gate: ClickGate = { ...input.gate, filled: false };
    const primary = safe.find((e) => (e.r === 'button' || e.r === 'link') && e.p === 1 && isPrimaryActionName(e.nm) && clickAllowed(e, gate));
    if (primary) {
      const reason = gate.flow ? 'this page is a step in the flow under way; this is its primary action' : 'nothing left to fill here; this is the page\'s primary action';
      out.push({ ...suggest(primary, 'click', primary.nm, context[0].id, reason), confidence: PRIMARY_CONFIDENCE });
    }
  }

  for (const e of safe) {
    if (e.r === 'checkbox' || e.r === 'switch' || e.r === 'radio') {
      if (e.st !== 'off' || !nameIsSpecific(e.nm)) continue;
      const hit = context.find((c) => affirms(c.text, e.nm));
      if (hit) out.push(suggest(e, 'check', e.nm, hit.id, `text says the user is "${e.nm}"`));
    } else if (e.r === 'slider') {
      for (const c of context) {
        const amount = amountFor(c.text, e);
        if (amount === null) continue;
        out.push(suggest(e, 'set', amount, c.id, `text names an amount for "${e.nm}"`));
        break;
      }
    }
  }
  return out.filter((s) => verbFits(elements.find((e) => e.i === s.elementId)!, s.verb, s.value));
}

function suggest(e: ElementDescriptor, verb: InteractSuggestion['verb'], value: string, sourceContextId: string, reason: string): InteractSuggestion {
  return { kind: 'interact', elementId: e.i, verb, value, confidence: CONFIDENCE, reason, sourceContextId };
}

function nameIsSpecific(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.length >= MIN_NAME_CHARS && !GENERIC_NAMES.has(n) && /[a-z]/.test(n);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function namePattern(name: string): RegExp {
  const words = name.trim().split(/\s+/).map(escapeRe).join('\\s+');
  return new RegExp(`(?<![a-z0-9])${words}(?![a-z0-9])`, 'gi');
}

/** The name appears as whole words in the text, negated or not. */
export function mentions(text: string, name: string): boolean {
  return namePattern(name).test(text);
}

/** The name appears as whole words in the text and the clause before it carries no negation. */
export function affirms(text: string, name: string): boolean {
  for (const m of text.matchAll(namePattern(name))) {
    if (!NEGATION.test(text.slice(Math.max(0, m.index - 24), m.index))) return true;
  }
  return false;
}

/** A number for the slider named in the text, scaled from a percentage when the range is not 0..100, else null. */
export function amountFor(text: string, e: ElementDescriptor): string | null {
  for (const m of text.matchAll(namePattern(e.nm))) {
    const after = AMOUNT_AFTER.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 32));
    const before = after ? null : AMOUNT_BEFORE.exec(text.slice(Math.max(0, m.index - 12), m.index));
    const hit = after ?? before;
    if (!hit) continue;
    let n = Number(hit[1]);
    if (!Number.isFinite(n)) continue;
    const min = e.min ?? 0;
    const max = e.max ?? 100;
    if (hit[2] === '%' && !(min === 0 && max === 100)) n = min + ((max - min) * n) / 100;
    if (e.step && e.step > 0) n = min + Math.round((n - min) / e.step) * e.step;
    n = Math.min(max, Math.max(min, n));
    return String(Number(n.toFixed(4)));
  }
  return null;
}
