import { isContentEditable } from '../fill/contenteditable';

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'file',
  'range',
  'color',
  'image',
  'hidden',
]);

export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type);
  if (el instanceof HTMLTextAreaElement) return true;
  return isContentEditable(el);
}

/**
 * `document.activeElement` stops at a shadow host; the field the user is
 * typing in may sit inside it (open roots only, which is what sites ship).
 */
export function deepActiveElement(doc: Document): Element | null {
  let el = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/**
 * Tab is only taken when nothing else could reasonably want it. Focus in a
 * different text field means the user is tabbing between fields, so it
 * passes through; the target itself, body, or a button are fair game.
 */
export function shouldInterceptTab(
  active: Element | null,
  target: Element,
  alsoFrom?: Element | null,
): boolean {
  if (active === null || active === target) return true;
  if (alsoFrom && active === alsoFrom) return true;
  if (active === active.ownerDocument.body) return true;
  if (target.contains(active)) return true;
  return !isTextEntry(active);
}
