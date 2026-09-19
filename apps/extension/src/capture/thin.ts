import { LIMITS } from '@carat/shared';
import { isVisible } from './visibility';

const MEDIA = 'img,canvas';
/** An image or canvas covering this share of the viewport is what the user is looking at, not the text. */
const BIG_FRACTION = 0.15;

/**
 * A thin page is one whose text capture probably missed what the user saw:
 * little visible text at all, or a large image or canvas in view (a pasted
 * screenshot in a chat, a map, a design tool).
 */
export function isThinPage(doc: Document, win: Window, bodyChars: number): boolean {
  if (bodyChars < LIMITS.thinTextChars) return true;
  const viewport = win.innerWidth * win.innerHeight;
  if (viewport <= 0) return false;
  for (const el of doc.querySelectorAll(MEDIA)) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, win.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0);
    if (w > 0 && h > 0 && (w * h) / viewport >= BIG_FRACTION && isVisible(el, win)) return true;
  }
  return false;
}
