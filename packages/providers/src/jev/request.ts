import type { NextActionRequest, OutlineControl } from '@carat/shared';
import { EAGERNESS } from '@carat/shared';
import { extractCandidates, notesAsSources } from '../local/candidates';

/**
 * One Jev call for carat: a `state` (the page, the notes, the history) and a
 * single choice question over the numbered controls plus a scroll and
 * nothing. Jev never writes text, so a text control is an option only when a
 * regex candidate gives it a value; everything else is a click.
 */

export const NEXT_QUESTION = 'next';
export const NONE = 'none';
export const SCROLL = 'scroll';
const MAX_OPTIONS = 16;
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

export interface JevOption {
  /** `c<n>`: the control's number in the outline. */
  key: string;
  control: OutlineControl;
  /** Set when the option is a fill: the regex candidate that goes into it. */
  value?: string;
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
}

const RULES = [
  'Pick the one thing the user is about to do on this page, or `none`.',
  'The history is the flow the user is in: a filled-in form wants its submit button, an opened dialog its primary action, a page they just landed on the thing they came for.',
  'The notes say what the user read elsewhere; an option that acts on a note beats one that does not.',
  'The focused control and the controls near it are the strongest signal.',
  'Never pick something that sends, pays, orders, deletes or signs out, and never a logout, a footer link or an ad.',
  'A scroll is right only for reading on, and wrong when a field or a button is what the user came for.',
  'When unsure, pick `none`: the writing model is asked in parallel and will answer.',
];

/** Null when the page has nothing worth asking about. */
export function buildJevRequest(req: NextActionRequest): JevRequest | null {
  const loose = EAGERNESS[req.eagerness].looseNames;
  const candidates = extractCandidates(notesAsSources(req.notes), loose);
  const options: JevOption[] = [];
  for (const control of req.controls) {
    if (/\bdisabled\b/.test(control.state ?? '') || control.risky) continue;
    if (TEXT_ROLES.has(control.role)) {
      if (control.value) continue;
      const candidate = candidates[0];
      if (!candidate) continue;
      options.push({ key: `c${control.n}`, control, value: candidate.value, reason: 'a value from what the user read fits this field' });
    } else {
      options.push({ key: `c${control.n}`, control, reason: `the page's ${control.role} "${control.name}"` });
    }
    if (options.length >= MAX_OPTIONS) break;
  }
  if (options.length === 0 && !req.page.scroll.more) return null;

  const choices: Record<string, string> = { [NONE]: 'Nothing on this page is the obvious next step.' };
  for (const o of options) {
    choices[o.key] = o.value
      ? `Type "${o.value}" into the ${o.control.role} "${o.control.name}" [${o.control.n}]`
      : `Press the ${o.control.role} "${o.control.name}" [${o.control.n}]`;
  }
  if (req.page.scroll.more) choices[SCROLL] = 'Scroll one viewport down and read on.';

  return {
    state: {
      page: { host: req.page.host, title: req.page.title, path: req.page.path, scroll: req.page.scroll },
      outline: req.outline,
      focused: req.focused ?? null,
      notes: req.notes,
      history: req.history,
      now: req.now,
    },
    questions: {
      [NEXT_QUESTION]: {
        type: 'choice',
        instructions: { question: 'What is the user most likely to do next on this page?', rules: RULES },
        criteria: { choices },
      },
    },
    options,
  };
}
