import { normalizeWhitespace } from '@carat/shared';
import { isHtml, isInput, isSelect } from '../dom/tags';
import { fillSelect } from '../fill/select';
import { inViewport, scrollToTarget } from '../scroll';
import type { ActionRole } from './controls';
import { SELECT_BUTTON, isSelectedCard, sliderFacts, toggleState } from './controls';

/** The verbs the content script can carry out on one control. */
export type ActionVerb = 'click' | 'check' | 'uncheck' | 'set' | 'choose' | 'scroll';

const MAX_KEY_STEPS = 200;

/**
 * One interaction, performed once. Returns false when the element cannot take
 * the verb, in which case nothing was touched. Called only from a chip's Tab.
 * `role` is what the snapshot called the element; an option card is clicked
 * through its own Select button or radio when it has one.
 */
export function performInteraction(el: Element, verb: ActionVerb, value: string, role?: ActionRole): boolean {
  switch (verb) {
    case 'click':
      return role === 'option' ? selectCard(el) : click(el);
    case 'check':
    case 'uncheck': {
      const state = toggleState(el);
      if (state === null) return false;
      // Already there: nothing to do, and certainly not a click that would undo it.
      if ((verb === 'check') === (state === 'on')) return true;
      return click(el);
    }
    case 'set':
      if (isInput(el) && el.type === 'range') return setRange(el, value);
      return el.getAttribute('role') === 'slider' && setAriaSlider(el as HTMLElement, value);
    case 'choose':
      return isSelect(el) && fillSelect(el, value);
    case 'scroll': {
      // The scheduler awaits the scroll itself so it can follow with a chip; here it is fire and forget.
      const win = el.ownerDocument.defaultView;
      if (!win) return false;
      void scrollToTarget(el, win);
      return true;
    }
  }
}

/**
 * True when the verb still makes sense against the live element: a box may
 * have been ticked since the snapshot, and an element the user has since
 * scrolled to has nothing left to scroll to.
 */
export function stillFits(el: Element, verb: ActionVerb, role?: ActionRole): boolean {
  if (!el.isConnected) return false;
  if (verb === 'check') return toggleState(el) === 'off';
  if (verb === 'uncheck') return toggleState(el) === 'on';
  if (verb === 'click' && role === 'option') return !isSelectedCard(el);
  if (verb === 'scroll') {
    const win = el.ownerDocument.defaultView;
    return !!win && !inViewport(el, win);
  }
  return true;
}

function click(el: Element): boolean {
  if (!isHtml(el)) return false;
  el.focus();
  el.click();
  return true;
}

/**
 * A card is picked through the control it offers for that: its Select
 * button, its radio, else the card itself. Custom cards often listen for
 * pointer events rather than click, so the whole press is dispatched.
 */
function selectCard(card: Element): boolean {
  const button = Array.from(card.querySelectorAll('button,[role="button"]')).find((b) =>
    SELECT_BUTTON.test(normalizeWhitespace(b.textContent ?? b.getAttribute('aria-label') ?? '')),
  );
  const control = button ?? card.querySelector('input[type="radio"],[role="radio"]') ?? card;
  if (!isHtml(control)) return false;
  if (control !== card) return click(control);
  control.focus();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
    control.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true }));
  }
  control.click();
  return true;
}

/**
 * Like text fills, through the prototype setter so React's value tracker sees
 * a change, then `input` and `change` as a drag would fire them.
 */
function setRange(el: HTMLInputElement, value: string): boolean {
  const { min = 0, max = 100, step } = sliderFacts(el);
  const target = snap(Number(value), min, max, step ?? 1);
  if (target === null) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  el.focus();
  if (setter) setter.call(el, String(target));
  else el.value = String(target);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * Custom sliders listen to keys and ignore attribute writes, so move by
 * ArrowRight/ArrowLeft steps (Home/End for the extremes) computed from
 * aria-valuemin/max/now and the step. If the widget did not move at all,
 * write aria-valuenow as the last resort.
 */
function setAriaSlider(el: HTMLElement, value: string): boolean {
  const { min = 0, max = 100, step = 1 } = sliderFacts(el);
  const now = Number(el.getAttribute('aria-valuenow') ?? min);
  const target = snap(Number(value), min, max, step);
  if (target === null || !Number.isFinite(now)) return false;
  if (target === now) return true;

  el.focus();
  const keys: string[] = [];
  if (target === min) keys.push('Home');
  else if (target === max) keys.push('End');
  else {
    const n = Math.round((target - now) / step);
    if (Math.abs(n) > MAX_KEY_STEPS) {
      // Too far to step: jump to the nearer end, then step back from there.
      const fromEnd = n > 0 ? Math.round((max - target) / step) : Math.round((target - min) / step);
      if (fromEnd > MAX_KEY_STEPS) return writeValueNow(el, target);
      keys.push(n > 0 ? 'End' : 'Home', ...Array<string>(fromEnd).fill(n > 0 ? 'ArrowLeft' : 'ArrowRight'));
    } else {
      keys.push(...Array<string>(Math.abs(n)).fill(n > 0 ? 'ArrowRight' : 'ArrowLeft'));
    }
  }
  for (const key of keys) press(el, key);

  const after = Number(el.getAttribute('aria-valuenow') ?? now);
  return after !== now || writeValueNow(el, target);
}

function writeValueNow(el: HTMLElement, target: number): boolean {
  el.setAttribute('aria-valuenow', String(target));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

const KEY_CODES: Record<string, number> = { ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 };

function press(el: HTMLElement, key: string): void {
  for (const type of ['keydown', 'keyup'] as const) {
    el.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: KEY_CODES[key], bubbles: true, cancelable: true }));
  }
}

/** `value` clamped to [min, max] and moved to the nearest step from min; null when it is not a number. */
export function snap(value: number, min: number, max: number, step: number): number | null {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.min(max, Math.max(min, value));
  if (!(step > 0)) return clamped;
  const stepped = min + Math.round((clamped - min) / step) * step;
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(6));
}
