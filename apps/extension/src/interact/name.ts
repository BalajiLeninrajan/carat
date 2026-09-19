import { normalizeWhitespace } from '@carat/shared';
import { labelOf } from '../snapshot/labels';

const FORM_CONTROLS = 'input,select';

/**
 * A short accessible name: aria-labelledby, aria-label, then a `<label>` for
 * form controls, the value of an `<input type=button>`, the element's own
 * text, a title, or the alt of an image inside. Not the full ARIA algorithm;
 * enough to name a button or a checkbox the way the user sees it.
 */
export function accessibleName(el: Element, doc: Document): string {
  const labelledby = idrefText(el.getAttribute('aria-labelledby'), doc);
  if (labelledby) return labelledby;
  const aria = normalizeWhitespace(el.getAttribute('aria-label') ?? '');
  if (aria) return aria;
  if (el.matches(FORM_CONTROLS)) {
    const label = labelOf(el, doc);
    if (label) return label;
    if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')) {
      return normalizeWhitespace(el.value);
    }
    return el instanceof HTMLInputElement && el.type === 'image' ? normalizeWhitespace(el.alt) : '';
  }
  const own = normalizeWhitespace(el.textContent ?? '');
  if (own) return own;
  const title = normalizeWhitespace(el.getAttribute('title') ?? '');
  if (title) return title;
  const img = el.querySelector('img[alt],svg title,[aria-label]');
  if (!img) return '';
  return normalizeWhitespace(img.getAttribute('alt') ?? img.getAttribute('aria-label') ?? img.textContent ?? '');
}

function idrefText(attr: string | null, doc: Document): string {
  if (!attr) return '';
  return normalizeWhitespace(
    attr
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
}
