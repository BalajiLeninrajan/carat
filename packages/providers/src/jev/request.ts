import type { ClickGate, Eagerness, ElementDescriptor, FieldDescriptor, InteractVerb, SuggestRequest } from '@carat/shared';
import { DEFAULT_EAGERNESS, EAGERNESS, clickAllowed, isDestructiveName, isPrimaryActionName } from '@carat/shared';
import { isNeverFill } from '../local/fields';
import { CANDIDATE_LABEL, extractCandidates, type Candidate } from '../local/candidates';
import { mentions } from '../local/interact';

/**
 * What one Jev call looks like for carat. Jev evaluates a `state` against typed
 * questions and returns calibrated probabilities; it never writes text. So the
 * candidate values come from the regexes, and Jev only decides which one (if
 * any) belongs in which field. Interactions work the same way: the elements
 * whose verb needs no written value (a click, a check, an uncheck) are the
 * options, and Jev picks one or `none`. Sliders and selects need a value Jev
 * cannot produce, so they are left to the regex and chat providers.
 */

export const GATE_QUESTION = 'relevant';
export const INTERACT_QUESTION = 'interact';
export const NONE = 'none';
const MAX_OPTIONS = 16;

export type Ctx = SuggestRequest['context'][number];

export interface JevOption {
  key: string; // 'k0'.. ; stable across the questions of one request
  candidate: Candidate;
  source: Ctx;
}

export interface JevInteractOption {
  key: string; // the element id
  element: ElementDescriptor;
  verb: InteractVerb;
  sourceContextId: string;
  reason: string;
}

export interface JevQuestion {
  type: 'noul' | 'choice';
  instructions: unknown;
  criteria: unknown;
}

export interface JevRequest {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  options: JevOption[];
  askedFields: FieldDescriptor[];
  interactOptions: JevInteractOption[];
}

export const questionKey = (fieldId: string): string => `field_${fieldId}`;

const RULES_HEAD = [
  'Only pick a candidate when its value clearly matches the purpose of the field. A vague topical match is `none`.',
  'A street address belongs in a location field. A place, plan or event name belongs in a title or search field. An email belongs in a recipient field. A phone number belongs in a phone field. Do not swap them.',
  'A comment box, description, message body, guest list or anything free-form takes `none`.',
  'The candidates were found by pattern matching and may be noise from an unrelated page; pick one only when the recent text shows the user is about to use it.',
];

// The last fill rule follows the eagerness level, like rule 11 of the chat
// prompt. The interaction rules do not: Esc undoes a chip, not a click.
const UNSURE_RULE: Record<Eagerness, string> = {
  conservative: 'When unsure, pick `none`. No suggestion beats a wrong one.',
  balanced: 'When unsure between candidates, pick the likelier one. Pick `none` when nothing specific fits.',
  eager: 'Lean toward picking: a wrong pick costs the user one keypress, a missed one a retype. Pick `none` only when no candidate relates to the field at all.',
};

export const fillRules = (eagerness: Eagerness): string[] => [...RULES_HEAD, UNSURE_RULE[eagerness]];

const INTERACT_RULES = [
  'A button or link is pressed only to commit fields carat itself just filled on this page (`filled` names their sources), or when it is the page\'s primary action with a continue-style name (Search, Continue, Next) and the option says so. Save, Create, Done and Apply are typical. A button that does anything else is `none`.',
  'A checkbox, switch or radio is changed only when a sentence in `context` states the user\'s own preference or fact in those words ("I\'m a vegetarian"), not negated and not about someone else.',
  'Never anything that sends, pays, orders, deletes or signs out. Nothing is chained: one control, pressed once.',
  'When unsure, pick `none`. No chip beats a wrong click.',
];

/**
 * Null when there is nothing to ask: no fillable field with a candidate and no
 * element worth a question. `context` must already exclude the page being filled.
 */
export function buildJevRequest(req: SuggestRequest, context: Ctx[], eagerness: Eagerness = DEFAULT_EAGERNESS): JevRequest | null {
  const rules = fillRules(eagerness);
  const askedFields = req.fields.filter((f) => !f.v && !isNeverFill(f));
  const byId = new Map(context.map((c) => [c.id, c]));
  const options: JevOption[] =
    askedFields.length === 0
      ? []
      : extractCandidates(context, EAGERNESS[eagerness].looseNames)
          .slice(0, MAX_OPTIONS)
          .map((candidate, i) => ({ key: `k${i}`, candidate, source: byId.get(candidate.sourceContextId)! }));
  const gate: ClickGate = { filled: (req.filled?.length ?? 0) > 0, flow: req.flow === true, eagerness, fillable: askedFields.length > 0 };
  const interactOptions = interactionOptions(req.elements ?? [], context, req.filled ?? [], gate);
  if (options.length === 0 && interactOptions.length === 0) return null;

  const state: Record<string, unknown> = {
    page: req.page,
    now: req.now,
    ...(req.locale ? { locale: req.locale } : {}),
    context: context.map((c) => ({ id: c.id, origin: c.origin, title: c.title, kind: c.kind, text: c.text })),
  };
  const questions: Record<string, JevQuestion> = {};

  if (options.length > 0) {
    state.fields = askedFields.map(describeField);
    state.candidates = options.map((o) => ({
      id: o.key,
      kind: CANDIDATE_LABEL[o.candidate.kind],
      value: o.candidate.value,
      from: o.source.id,
    }));

    const criteria: Record<string, unknown> = {};
    for (const o of options) {
      criteria[o.key] = {
        value: o.candidate.value,
        kind: CANDIDATE_LABEL[o.candidate.kind],
        source: sourceLabel(o.source),
      };
    }
    criteria[NONE] = 'None of these belongs in this field, or the field takes a different kind of value';

    questions[GATE_QUESTION] = {
      type: 'noul',
      instructions: {
        question: 'The user is on `page` with the empty `fields` listed. Is there a specific value in `context` (something in `candidates`) that they are about to type into one of these fields?',
        rules,
      },
      criteria: {
        true: 'At least one candidate is exactly what the user would type into one of the fields on this page',
        false: 'The recent text is unrelated to this page, or nothing in it belongs in any of these fields',
      },
    };
    for (const field of askedFields) {
      questions[questionKey(field.i)] = {
        type: 'choice',
        instructions: {
          task: 'Pick the candidate whose value the user is about to type into this field, or `none`.',
          field: describeField(field),
          rules,
        },
        criteria,
      };
    }
  }

  if (interactOptions.length > 0) {
    state.elements = interactOptions.map((o) => describeElement(o.element));
    if (req.filled && req.filled.length > 0) state.filled = req.filled;

    const criteria: Record<string, unknown> = {};
    for (const o of interactOptions) {
      criteria[o.key] = { action: `${o.verb} "${o.element.nm}"`, ...describeElement(o.element), because: o.reason };
    }
    criteria[NONE] = 'No control on this page should be pressed right now';

    questions[INTERACT_QUESTION] = {
      type: 'choice',
      instructions: {
        task: 'Pick the one control on `page` the user is about to press next, or `none`.',
        rules: INTERACT_RULES,
      },
      criteria,
    };
  }

  return { state, questions, options, askedFields, interactOptions };
}

/**
 * Elements Jev may be asked about: a button or link after carat filled
 * something (it cites the fill's source), or the primary action when the
 * click gate lets it through without one (it cites the newest context item);
 * a toggle only when a context item names it (it cites that item).
 * Destructive names never appear, nor do money controls: Jev is not asked
 * about paying. Whether the sentence affirms or negates the toggle is Jev's call.
 */
function interactionOptions(elements: ElementDescriptor[], context: Ctx[], filled: string[], gate: ClickGate): JevInteractOption[] {
  const out: JevInteractOption[] = [];
  for (const element of elements) {
    if (isDestructiveName(element.nm) || element.m === 1) continue;
    if (element.r === 'button' || element.r === 'link') {
      const source = filled[0];
      if (source !== undefined) {
        out.push({ key: element.i, element, verb: 'click', sourceContextId: source, reason: 'carat just filled fields on this page' });
      } else if (context[0] && element.p === 1 && isPrimaryActionName(element.nm) && clickAllowed(element, gate)) {
        out.push({ key: element.i, element, verb: 'click', sourceContextId: context[0].id, reason: gate.flow ? 'the primary action of a step in the flow under way' : 'the primary action, with nothing left to fill' });
      }
    } else if (element.r === 'checkbox' || element.r === 'switch' || element.r === 'radio') {
      if (element.r === 'radio' && element.st === 'on') continue;
      const named = context.find((c) => mentions(c.text, element.nm));
      if (!named) continue;
      const verb: InteractVerb = element.st === 'on' ? 'uncheck' : 'check';
      out.push({ key: element.i, element, verb, sourceContextId: named.id, reason: `text in ${sourceLabel(named)} names it` });
    }
  }
  return out.slice(0, MAX_OPTIONS);
}

function describeField(f: FieldDescriptor): Record<string, unknown> {
  return {
    id: f.i,
    type: f.t,
    ...(f.nm ? { name: f.nm } : {}),
    ...(f.ph ? { placeholder: f.ph } : {}),
    ...(f.al ? { aria_label: f.al } : {}),
    ...(f.lb ? { label: f.lb } : {}),
    ...(f.nb ? { nearby_text: f.nb } : {}),
    ...(f.ac ? { autocomplete: f.ac } : {}),
    ...(f.f ? { focused: true } : {}),
  };
}

function describeElement(e: ElementDescriptor): Record<string, unknown> {
  return {
    id: e.i,
    role: e.r,
    name: e.nm,
    ...(e.st ? { state: e.st } : {}),
    ...(e.nb ? { nearby_text: e.nb } : {}),
    ...(e.p ? { primary: true } : {}),
  };
}

export function sourceLabel(ctx: Ctx): string {
  let host = ctx.origin;
  try {
    host = new URL(ctx.origin).host;
  } catch {
    // keep the raw origin
  }
  return ctx.title ? `${ctx.title} (${host})` : host;
}
