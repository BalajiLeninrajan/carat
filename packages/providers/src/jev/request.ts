import type { FieldDescriptor, SuggestRequest } from '@carat/shared';
import { isNeverFill } from '../local/fields';
import { CANDIDATE_LABEL, extractCandidates, type Candidate } from '../local/candidates';

/**
 * What one Jev call looks like for carat. Jev evaluates a `state` against typed
 * questions and returns calibrated probabilities; it never writes text. So the
 * candidate values come from the regexes, and Jev only decides which one (if
 * any) belongs in which field.
 */

export const GATE_QUESTION = 'relevant';
export const NONE = 'none';
const MAX_OPTIONS = 16;

export type Ctx = SuggestRequest['context'][number];

export interface JevOption {
  key: string; // 'k0'.. ; stable across the questions of one request
  candidate: Candidate;
  source: Ctx;
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
}

export const questionKey = (fieldId: string): string => `field_${fieldId}`;

const RULES = [
  'Only pick a candidate when its value clearly matches the purpose of the field. A vague topical match is `none`.',
  'A street address belongs in a location field. A place, plan or event name belongs in a title or search field. An email belongs in a recipient field. A phone number belongs in a phone field. Do not swap them.',
  'A comment box, description, message body, guest list or anything free-form takes `none`.',
  'The candidates were found by pattern matching and may be noise from an unrelated page; pick one only when the recent text shows the user is about to use it.',
  'When unsure, pick `none`. No suggestion beats a wrong one.',
];

/** Null when there is nothing to ask: no fillable field or no candidate. `context` must already exclude the page being filled. */
export function buildJevRequest(req: SuggestRequest, context: Ctx[]): JevRequest | null {
  const askedFields = req.fields.filter((f) => !f.v && !isNeverFill(f));
  if (askedFields.length === 0 || context.length === 0) return null;

  const byId = new Map(context.map((c) => [c.id, c]));
  const options: JevOption[] = extractCandidates(context)
    .slice(0, MAX_OPTIONS)
    .map((candidate, i) => ({ key: `k${i}`, candidate, source: byId.get(candidate.sourceContextId)! }));
  if (options.length === 0) return null;

  const state = {
    page: req.page,
    now: req.now,
    ...(req.locale ? { locale: req.locale } : {}),
    fields: askedFields.map(describeField),
    candidates: options.map((o) => ({
      id: o.key,
      kind: CANDIDATE_LABEL[o.candidate.kind],
      value: o.candidate.value,
      from: o.source.id,
    })),
    context: context.map((c) => ({ id: c.id, origin: c.origin, title: c.title, kind: c.kind, text: c.text })),
  };

  const criteria: Record<string, unknown> = {};
  for (const o of options) {
    criteria[o.key] = {
      value: o.candidate.value,
      kind: CANDIDATE_LABEL[o.candidate.kind],
      source: sourceLabel(o.source),
    };
  }
  criteria[NONE] = 'None of these belongs in this field, or the field takes a different kind of value';

  const questions: Record<string, JevQuestion> = {
    [GATE_QUESTION]: {
      type: 'noul',
      instructions: {
        question: 'The user is on `page` with the empty `fields` listed. Is there a specific value in `context` (something in `candidates`) that they are about to type into one of these fields?',
        rules: RULES,
      },
      criteria: {
        true: 'At least one candidate is exactly what the user would type into one of the fields on this page',
        false: 'The recent text is unrelated to this page, or nothing in it belongs in any of these fields',
      },
    },
  };
  for (const field of askedFields) {
    questions[questionKey(field.i)] = {
      type: 'choice',
      instructions: {
        task: 'Pick the candidate whose value the user is about to type into this field, or `none`.',
        field: describeField(field),
        rules: RULES,
      },
      criteria,
    };
  }

  return { state, questions, options, askedFields };
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

export function sourceLabel(ctx: Ctx): string {
  let host = ctx.origin;
  try {
    host = new URL(ctx.origin).host;
  } catch {
    // keep the raw origin
  }
  return ctx.title ? `${ctx.title} (${host})` : host;
}
