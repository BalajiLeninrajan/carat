import type { Eagerness, ElementDescriptor, FieldDescriptor, InteractSuggestion, PageKind, PageState, SuggestRequest, Suggestion } from '@carat/shared';
import {
  DEFAULT_EAGERNESS,
  EAGERNESS,
  PAGE_QUERY_CONFIDENCE,
  PAGE_SCROLL_DONE,
  PAGE_SOURCE,
  elementKey,
  firstMatchingLink,
  isContinueName,
  isDestructiveName,
  isOffScreen,
  isOptionalField,
  pageIntent,
  pageQueryClick,
  weakBelow,
} from '@carat/shared';
import { sameSite } from './same-site';
import { fillSources, fills, type FillSources } from './local/fills';

/**
 * What each prior is worth. The obvious cases sit above the eager prior
 * floor (0.5); the matching result, Continue and a scroll clear the balanced
 * one (0.6) too; nothing clears conservative, which shows only
 * context-backed fills.
 */
export const PRIOR_CONFIDENCE = {
  /** A result whose host or title matches the page's query. The pre-check's number, so the two answers are one. */
  serpMatch: PAGE_QUERY_CONFIDENCE,
  /** No result matches; the first organic one is still the likeliest click. */
  serpFirst: 0.5,
  checkoutContinue: 0.7,
  /** A plain form's Continue: likely, but the form may still want something carat cannot see. Eager only. */
  formContinue: 0.55,
  /**
   * One screen down an article or a feed. At the balanced floor, not under
   * it: a page with more below and nothing else to do is the one case where
   * the next step is obvious, and leaving it at 0.55 sent every article to
   * the model at balanced for an answer the page already had.
   */
  scroll: 0.6,
} as const;

/** One next action the page itself justifies, before any floor is applied. */
export interface Prior {
  suggestion: Suggestion;
  /** Why, in the words the popup and the Jev question use. */
  note: string;
}

export interface NextStep {
  kind: PageKind | undefined;
  /** Every candidate the page kind yields, best first, before the level's prior floor. Jev ranks these. */
  candidates: Prior[];
  /** The candidates at or over the level's prior floor, minus a scroll when something better is on offer. */
  suggestions: Suggestion[];
  /** The best page-justified candidate's confidence, or 0. Under the prior floor, the model is worth asking. */
  best: number;
  /** Why, without the page kind in front: "first result matches query 'doordash'". */
  reason: string;
  /** The same line with the kind in front: "serp: first result matches query 'doordash'". */
  note: string;
}

const NONE: NextStep = { kind: undefined, candidates: [], suggestions: [], best: 0, reason: 'no page state', note: 'no page state' };

/**
 * The local predictor: no network, one prior per page kind. A results page
 * wants the result that matches its query, else the first one. A form or
 * checkout wants its first empty field filled from another tab's text when a
 * value fits, and once no empty field remains, its Continue. An article or a
 * feed, or a results page scrolled past its first screen, wants a scroll,
 * but only when no fill or click that clears the next stricter level's floor
 * is on offer, and never twice in a row without new content. A search app
 * (Maps, Calendar) keeps the plain fill logic and adds nothing.
 *
 * `known` is what the caller already has from context (fills, interactions)
 * so the scroll can defer to it; the local provider passes its own fills.
 */
export function nextStep(req: SuggestRequest, eagerness: Eagerness = DEFAULT_EAGERNESS, known: Suggestion[] = []): NextStep {
  const state = req.state;
  if (!state) return NONE;
  const knobs = EAGERNESS[eagerness];
  const context = knobs.sameOriginContext ? req.context : req.context.filter((c) => !sameSite(c.origin, req.page.host));
  const done = new Set(state.done ?? []);
  // Anything already accepted on this page load is finished business, whatever the prior says.
  const elements = (req.elements ?? []).filter((e) => !isDestructiveName(e.nm) && !done.has(elementKey(e.r, e.nm)));
  const candidates: Prior[] = [];
  let note: string;

  switch (state.kind) {
    case 'serp': {
      const pick = serpResult(state, elements, done);
      if (pick) {
        candidates.push(pick);
        note = pick.note;
      } else {
        note = state.y >= 1 ? 'past the first screen' : 'no result links';
      }
      if (!pick || state.y >= 1) {
        const scroll = pageScroll(state, done);
        if (scroll) candidates.push(scroll);
        if (scroll && !pick) note = `${note}, scroll`;
      }
      break;
    }
    case 'form':
    case 'checkout': {
      const step = formStep(state.kind, req.fields, elements, fillSources(req, context), knobs.looseNames);
      if (step.prior) candidates.push(step.prior);
      note = step.note;
      break;
    }
    case 'article':
    case 'feed': {
      const scroll = pageScroll(state, done);
      if (scroll) candidates.push(scroll);
      note = scroll ? 'scroll' : done.has(PAGE_SCROLL_DONE) ? 'scrolled, nothing new below' : 'at the end';
      break;
    }
    case 'search-app':
      note = context.length > 0 || (req.own ?? []).length > 0 ? 'fill from context' : 'nothing read to fill from';
      break;
    case 'unknown':
      note = 'no prior';
      break;
  }

  const pageBacked = candidates.filter((c) => c.suggestion.sourceContextId === PAGE_SOURCE);
  const best = Math.max(0, ...pageBacked.map((c) => c.suggestion.confidence));
  // A fill from context stands on its own floor; only what the page alone justifies faces the prior floor.
  const kept = candidates.filter((c) => c.suggestion.sourceContextId !== PAGE_SOURCE || c.suggestion.confidence >= knobs.priorMin);
  if (pageBacked.length > 0 && kept.length < candidates.length) note = `${note}, under the ${eagerness} prior floor (${knobs.priorMin})`;
  const better = [...known, ...kept.map((c) => c.suggestion)].some((s) => !isScroll(s) && s.confidence >= weakBelow(eagerness));
  const suggestions = kept.map((c) => c.suggestion).filter((s) => !isScroll(s) || !better);
  return { kind: state.kind, candidates, suggestions, best, reason: note, note: `${state.kind}: ${note}` };
}

const isScroll = (s: Suggestion): boolean => s.kind === 'interact' && s.verb === 'scroll';

/**
 * The result link whose site or title is what the user searched for, else the
 * first result link. The match is `pageQueryClick`, the very suggestion the
 * orchestrator's synchronous pre-check builds, so the pre-check and this
 * prior are one answer and not two chips; this side only adds the case the
 * pre-check has nothing to say about, the first organic result at 0.5. Past
 * the first screen only on-screen links count, so the scroll takes over once
 * the user has read past the top matches.
 */
function serpResult(state: PageState, elements: ElementDescriptor[], done: Set<string>): Prior | null {
  const links = elements.filter((e) => e.r === 'link' && !done.has(elementKey(e.r, e.nm)) && (state.y < 1 || !isOffScreen(e)));
  if (links.length === 0) return null;
  const intent = pageIntent(state);
  const match = firstMatchingLink(links, intent);
  if (match && intent) {
    return { suggestion: pageQueryClick(match, intent), note: `first result matches query '${intent.query}'` };
  }
  return { suggestion: click(links[0]!, PRIOR_CONFIDENCE.serpFirst, 'first result on the results page'), note: 'first result' };
}

/**
 * Required fields first, then the rest in snapshot order. A field a context
 * value fits is the step; one with no value is skipped, since a bare "Focus
 * Email?" is not worth a Tab. Once no empty field remains, the Continue.
 */
function formStep(
  kind: 'form' | 'checkout',
  fields: FieldDescriptor[],
  elements: ElementDescriptor[],
  from: FillSources,
  loose: boolean,
): { prior: Prior | null; note: string } {
  const empty = fields.filter((f) => !f.v);
  const required = empty.filter((f) => f.rq === 1);
  const ordered = [...required, ...empty.filter((f) => f.rq !== 1)];
  const byField = new Map(fills(ordered, from, loose).map((f) => [f.fieldId, f] as const));
  for (const field of ordered) {
    const fill = byField.get(field.i);
    if (fill) return { prior: { suggestion: fill, note: `fill "${fieldName(field)}" from context` }, note: `fill "${fieldName(field)}" from context` };
  }
  const remaining = required.length > 0 ? required : empty.filter((f) => !isOptionalField(f));
  if (remaining.length > 0) return { prior: null, note: `no value for '${fieldName(remaining[0]!)}'` };
  const buttons = elements.filter((e) => e.r === 'button' && isContinueName(e.nm));
  const button = buttons.find((e) => e.p === 1) ?? buttons[0];
  if (!button) return { prior: null, note: 'fields filled, no Continue button' };
  const confidence = kind === 'checkout' ? PRIOR_CONFIDENCE.checkoutContinue : PRIOR_CONFIDENCE.formContinue;
  return {
    prior: { suggestion: click(button, confidence, 'no empty field remains; this button moves the form on'), note: `Continue ("${button.nm}")` },
    note: `Continue ("${button.nm}")`,
  };
}

function pageScroll(state: PageState, done: Set<string>): Prior | null {
  if (!state.more || done.has(PAGE_SCROLL_DONE)) return null;
  const suggestion: InteractSuggestion = {
    kind: 'interact',
    elementId: '',
    verb: 'scroll',
    value: '',
    confidence: PRIOR_CONFIDENCE.scroll,
    reason: 'a page for reading, with more below the fold',
    sourceContextId: PAGE_SOURCE,
  };
  return { suggestion, note: 'scroll' };
}

function click(e: ElementDescriptor, confidence: number, reason: string): InteractSuggestion {
  return { kind: 'interact', elementId: e.i, verb: 'click', value: e.nm, confidence, reason, sourceContextId: PAGE_SOURCE };
}

/** What the popup calls a field: its label, aria-label, placeholder or name. */
export function fieldName(d: FieldDescriptor): string {
  return d.lb || d.al || d.ph || d.nm || d.i;
}
