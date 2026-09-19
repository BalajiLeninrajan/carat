import { isDenylisted } from '@carat/shared';
import { collectVisibleText } from './text';

const MIN_CHARS = 40;

export type CaptureLocation = Pick<Location, 'protocol' | 'hostname'>;

/**
 * Whether this page's text may be stored at all. `text` is the already
 * collected body text when the caller has it; otherwise it is collected here.
 */
export function shouldCapture(doc: Document, location: CaptureLocation, text?: string): boolean {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
  if (isDenylisted(location.hostname)) return false;
  if (doc.querySelector('input[type="password" i]')) return false;
  return (text ?? collectVisibleText(doc)).length >= MIN_CHARS;
}
