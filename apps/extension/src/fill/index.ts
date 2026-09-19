import { isHtml, isSelect } from '../dom/tags';
import { getAdapter } from './adapters';
import { fillContentEditable, isContentEditable } from './contenteditable';
import { fillDateInput, isDateField, parseDate, pickFromCalendar } from './date';
import { isPickCombobox, pickFromListbox } from './pick';
import { fillSelect } from './select';
import { fillTextControl, isTextControl } from './text';

export { fillContentEditable, isContentEditable } from './contenteditable';
export { fillSelect } from './select';
export { fillTextControl, isTextControl, valueOf } from './text';
export { ADAPTERS, getAdapter, resolveTarget, serpLinks } from './adapters';
export type { HostAdapter, LinkCandidate } from './adapters';
export { PICK_TIMING, findListbox, isPickCombobox, matchOption, pickFromListbox } from './pick';
export type { PickOutcome } from './pick';
export { DATE_TIMING, findCell, fillDateInput, formatDate, isDateField, parseDate, pickFromCalendar } from './date';
export type { DateOutcome, DateParts } from './date';
export { waitFor } from './wait';

const INNER_CONTROL = 'input, textarea, [contenteditable]:not([contenteditable=false])';

/**
 * How a fill ended. `done`: the value is in and any list or calendar it
 * opened was picked from. `partial`: the text is in the field but the pick
 * that should have followed did not happen (no list appeared, no option
 * matched, the calendar never reached the month), so the field may still
 * need a hand. Reported in feedback so the next request knows.
 */
export type FillOutcome = 'done' | 'partial';

export interface PerformFillOptions {
  /** The page's language, for the date format a plain text field expects. */
  locale?: string;
}

/** Returns false when nothing on the element accepts text. */
export function fillElement(el: Element, value: string, host: string): boolean {
  const target = pickControl(el);
  if (!target) return false;

  if (isTextControl(target)) fillTextControl(target, value);
  else if (isSelect(target)) {
    if (!fillSelect(target, value)) return false;
  } else if (isContentEditable(target)) fillContentEditable(target, value);
  else return false;

  getAdapter(host)?.postFill?.(target);
  return true;
}

/**
 * The whole fill, including the step that usually follows the typing: a
 * date field gets the date in the format it wants and, if a calendar opens,
 * the day pressed in it; a combobox that opens a list gets the first
 * matching option picked. One Tab covers it. Null when nothing accepts text.
 */
export async function performFill(el: Element, value: string, host: string, opts: PerformFillOptions = {}): Promise<FillOutcome | null> {
  const target = pickControl(el);
  if (!target) return null;

  if (isTextControl(target) && isDateField(target)) {
    const parts = parseDate(value);
    if (parts) {
      fillDateInput(target, parts, opts.locale);
      getAdapter(host)?.postFill?.(target);
      return pickFromCalendar(target, parts);
    }
  }
  if (!fillElement(el, value, host)) return null;
  if (isPickCombobox(target)) return pickFromListbox(target, value);
  return 'done';
}

// role=combobox is often a wrapper div around the real input.
function pickControl(el: Element): Element | null {
  if (isTextControl(el) || isSelect(el)) return el;
  if (isHtml(el) && el.getAttribute('contenteditable') !== null) {
    return el.getAttribute('contenteditable') === 'false' ? null : el;
  }
  const inner = el.querySelector(INNER_CONTROL);
  if (inner) return inner;
  return isContentEditable(el) ? el : null;
}
