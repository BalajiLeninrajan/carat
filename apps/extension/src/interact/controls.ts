import { normalizeWhitespace } from '@carat/shared';
import { isDetails, isInput } from '../dom/tags';
import { textExcluding } from '../snapshot/labels';

/**
 * What an element is, for performing: the outline tells the model a
 * `ControlRole`, this tells the content script which verb an element can
 * take. `disclosure` and `option` have no place in the outline's vocabulary
 * but still change how a press is carried out.
 */
export type ActionRole =
  | 'button'
  | 'link'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'slider'
  | 'select'
  | 'tab'
  | 'menuitem'
  | 'disclosure'
  | 'option';

const ARIA_ROLES: ReadonlySet<string> = new Set(['button', 'checkbox', 'switch', 'radio', 'slider', 'tab', 'menuitem', 'option']);

/** A button whose only job is to pick the card around it: "Select", "Select flight", "Choose this fare". */
export const SELECT_BUTTON = /^(?:select|choose|pick)(?:\s+(?:this|flight|fare|option|plan|room|seat|rate|ticket|departure|return|outbound|inbound))*$/i;
/** The card climb stops at a list or a form: those hold many cards, not one. */
const CARD_BOUNDARY = 'ul,ol,form,main,body,table,[role="list"],[role="listbox"],[role="radiogroup"],[role="group"]';
const SELECTED_CLASS = /(?:^|[\s_-])(?:selected|chosen|active|is-selected|is-active)(?:$|[\s_-])/i;
/** A card needs this much text of its own before its Select button is folded into it. */
const CARD_MIN_TEXT = 8;
const CARD_MAX_CLIMB = 6;

/** Which role an element plays, or null when it is none of them. */
export function roleOf(el: Element): ActionRole | null {
  const aria = el.getAttribute('role')?.toLowerCase();
  const tag = el.tagName.toLowerCase();
  const type = isInput(el) ? el.type : '';
  const buttonLike = aria === 'button' || tag === 'button' || (tag === 'input' && (type === 'button' || type === 'submit' || type === 'image'));
  if (buttonLike) {
    if (el.hasAttribute('aria-pressed')) return 'switch';
    if (el.hasAttribute('aria-expanded')) return 'disclosure';
    return 'button';
  }
  if (aria && ARIA_ROLES.has(aria)) return aria as ActionRole;
  if (tag === 'a') return 'link';
  if (tag === 'summary') return 'disclosure';
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
  }
  // A card that says whether it is chosen, with no role of its own: a fare, a room, a plan.
  if (!aria && (el.hasAttribute('aria-selected') || el.hasAttribute('aria-pressed'))) return 'option';
  return null;
}

/** 'on' or 'off' for anything checkable (native, aria-checked or aria-pressed), else null. */
export function toggleState(el: Element): 'on' | 'off' | null {
  if (isInput(el) && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'on' : 'off';
  const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
  if (checked === null) return null;
  return checked.toLowerCase() === 'true' ? 'on' : 'off';
}

export function isExpanded(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'summary') return isDetails(el.parentElement) && el.parentElement.open;
  return el.getAttribute('aria-expanded') === 'true';
}

/**
 * The card a Select button belongs to: the widest ancestor that still holds
 * only this one Select button and has some text of its own, stopping short
 * of the list or form around all the cards. Null when the button stands alone.
 */
export function cardAround(button: Element): Element | null {
  let card: Element | null = null;
  let node = button.parentElement;
  for (let depth = 0; node && depth < CARD_MAX_CLIMB; depth++, node = node.parentElement) {
    if (node.matches(CARD_BOUNDARY)) break;
    if (selectButtonsIn(node) > 1) break;
    card = node;
  }
  if (!card) return null;
  return textExcluding(card, button).length >= CARD_MIN_TEXT ? card : null;
}

function selectButtonsIn(root: Element): number {
  let n = 0;
  for (const b of root.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')) {
    const label = isInput(b) ? b.value : (b.textContent ?? b.getAttribute('aria-label') ?? '');
    if (SELECT_BUTTON.test(normalizeWhitespace(label))) n++;
  }
  return n;
}

/** Whether a card is already the chosen one: an ARIA state, a checked radio inside, or a class that says so. */
export function isSelectedCard(el: Element): boolean {
  for (const attr of ['aria-selected', 'aria-pressed', 'aria-checked']) {
    if (el.getAttribute(attr)?.toLowerCase() === 'true') return true;
  }
  if (el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') return true;
  if (el.querySelector('input[type="radio"]:checked,[role="radio"][aria-checked="true"]')) return true;
  return SELECTED_CLASS.test(el.className);
}

export interface SliderFacts {
  v?: string;
  min?: number;
  max?: number;
  step?: number;
}

/** Value and range of a native range input or an ARIA slider, numbers only. */
export function sliderFacts(el: Element): SliderFacts {
  const out: SliderFacts = {};
  const num = (v: string | null | undefined): number | undefined => {
    if (v === null || v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  if (isInput(el)) {
    out.v = el.value;
    out.min = num(el.min) ?? 0;
    out.max = num(el.max) ?? 100;
    const step = num(el.step);
    if (step !== undefined && step > 0) out.step = step;
    return out;
  }
  const now = num(el.getAttribute('aria-valuenow'));
  if (now !== undefined) out.v = String(now);
  out.min = num(el.getAttribute('aria-valuemin')) ?? 0;
  out.max = num(el.getAttribute('aria-valuemax')) ?? 100;
  const step = num(el.getAttribute('step') ?? el.getAttribute('data-step'));
  if (step !== undefined && step > 0) out.step = step;
  return out;
}
