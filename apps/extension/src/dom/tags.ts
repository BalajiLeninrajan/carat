/**
 * What kind of element this is, asked without `instanceof`. Every document
 * has its own copy of the DOM classes, so an input inside a child frame is
 * not an instance of the top frame's `HTMLInputElement`, and caret now reads
 * and fills inside same-origin frames from the top frame. Tag names are the
 * same in every realm; where a tag will not do (`HTMLElement` covers every
 * tag there is), the element's own window supplies the class.
 */

/** The window the element belongs to, which owns the classes it is an instance of. */
export function windowOf(el: unknown): (Window & typeof globalThis) | null {
  const doc = (el as { ownerDocument?: Document | null } | null | undefined)?.ownerDocument;
  return (doc?.defaultView as (Window & typeof globalThis) | null | undefined) ?? null;
}

function tagIs(el: unknown, tag: string): boolean {
  const name = (el as { tagName?: unknown } | null | undefined)?.tagName;
  return typeof name === 'string' && name.toLowerCase() === tag;
}

export function isInput(el: unknown): el is HTMLInputElement {
  return tagIs(el, 'input');
}

export function isTextArea(el: unknown): el is HTMLTextAreaElement {
  return tagIs(el, 'textarea');
}

export function isSelect(el: unknown): el is HTMLSelectElement {
  return tagIs(el, 'select');
}

export function isIframe(el: unknown): el is HTMLIFrameElement {
  return tagIs(el, 'iframe');
}

export function isDetails(el: unknown): el is HTMLDetailsElement {
  return tagIs(el, 'details');
}

/** A `<button>` or an `<input>`, the two tags with a `type` that can be `submit`. */
export function isButtonish(el: unknown): el is HTMLButtonElement | HTMLInputElement {
  return tagIs(el, 'button') || isInput(el);
}

/** An HTML element, whichever document it came from: it has `focus`, `click` and a `style`. */
export function isHtml(el: unknown): el is HTMLElement {
  if (el instanceof HTMLElement) return true;
  const win = windowOf(el);
  return !!win && typeof win.HTMLElement === 'function' && el instanceof win.HTMLElement;
}
