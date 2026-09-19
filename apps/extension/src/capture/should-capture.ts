import { isDenylisted } from '@carat/shared';
import { collectVisibleText } from './text';
import { isVisible } from './visibility';

const MIN_CHARS = 40;

export type CaptureLocation = Pick<Location, 'protocol' | 'hostname'>;

/** Whether anything from this page, text or pixels, may leave it at all. */
export function mayCapture(doc: Document, location: CaptureLocation): boolean {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
  if (isDenylisted(location.hostname)) return false;
  return !hasVisiblePasswordField(doc);
}

/**
 * Whether this page's text may be stored. `text` is the already collected
 * body text when the caller has it; otherwise it is collected here.
 */
export function shouldCapture(doc: Document, location: CaptureLocation, text?: string): boolean {
  if (!mayCapture(doc, location)) return false;
  return (text ?? collectVisibleText(doc)).length >= MIN_CHARS;
}

/**
 * A password field the user can see means a login form. One parked in a
 * hidden dialog (Discord, GitHub and most SPAs keep one around) says nothing
 * about the page being read.
 */
export function hasVisiblePasswordField(doc: Document): boolean {
  const win = doc.defaultView;
  if (!win) return false;
  for (const el of doc.querySelectorAll('input[type="password" i]')) {
    if (isVisible(el, win)) return true;
  }
  return false;
}
