import { isIframe, isInput, isTextArea } from '../dom/tags';
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
  if (isInput(el)) return !NON_TEXT_INPUT_TYPES.has(el.type);
  if (isTextArea(el)) return true;
  return isContentEditable(el);
}

/**
 * `document.activeElement` stops at a shadow host or a frame element; the
 * field the user is typing in may sit inside either (open roots and
 * same-origin frames only; a cross-origin frame stays opaque and is returned
 * as the iframe itself).
 */
export function deepActiveElement(doc: Document): Element | null {
  let el = doc.activeElement;
  for (let hops = 0; el && hops < 16; hops++) {
    if (el.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    else if (isIframe(el) && innerActive(el)) el = innerActive(el);
    else break;
  }
  return el;
}

function innerActive(frame: HTMLIFrameElement): Element | null {
  try {
    return frame.contentDocument?.activeElement ?? null;
  } catch {
    return null;
  }
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
