import { getAdapter } from './adapters';
import { fillContentEditable, isContentEditable } from './contenteditable';
import { fillSelect } from './select';
import { fillTextControl, isTextControl } from './text';

export { fillContentEditable, isContentEditable } from './contenteditable';
export { fillSelect } from './select';
export { fillTextControl, isTextControl } from './text';
export { ADAPTERS, getAdapter, resolveTarget } from './adapters';
export type { HostAdapter } from './adapters';

const INNER_CONTROL = 'input, textarea, [contenteditable]:not([contenteditable=false])';

/** Returns false when nothing on the element accepts text. */
export function fillElement(el: Element, value: string, host: string): boolean {
  const target = pickControl(el);
  if (!target) return false;

  if (isTextControl(target)) fillTextControl(target, value);
  else if (target instanceof HTMLSelectElement) {
    if (!fillSelect(target, value)) return false;
  } else if (isContentEditable(target)) fillContentEditable(target, value);
  else return false;

  getAdapter(host)?.postFill?.(target);
  return true;
}

// role=combobox is often a wrapper div around the real input.
function pickControl(el: Element): Element | null {
  if (isTextControl(el) || el instanceof HTMLSelectElement) return el;
  if (el instanceof HTMLElement && el.getAttribute('contenteditable') !== null) {
    return el.getAttribute('contenteditable') === 'false' ? null : el;
  }
  const inner = el.querySelector(INNER_CONTROL);
  if (inner) return inner;
  return isContentEditable(el) ? el : null;
}
