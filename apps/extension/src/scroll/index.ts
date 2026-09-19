import { isHtml } from '../dom/tags';

/** Scroll events this far apart mean the smooth scroll has stopped. */
export const SCROLL_SETTLE_MS = 120;
/** However long the page keeps scrolling, the chip follows after this. */
export const SCROLL_MAX_MS = 1000;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * The element's box in `win`'s viewport coordinates. For an element inside a
 * same-origin child frame, each frame element's box on the way up is added,
 * so the chip lands over the field and not at the top-left of the page. The
 * walk stops at `win`, or at a frame it cannot see into.
 */
export function viewportRect(el: Element, win: Window): DOMRect {
  let rect = el.getBoundingClientRect();
  let current = el.ownerDocument.defaultView;
  for (let hops = 0; current && current !== win && hops < 8; hops++) {
    const frame = frameElementOf(current);
    if (!frame) break;
    const fr = frame.getBoundingClientRect();
    rect = new DOMRect(rect.x + fr.x + frame.clientLeft, rect.y + fr.y + frame.clientTop, rect.width, rect.height);
    current = frame.ownerDocument.defaultView;
  }
  return rect;
}

/** The frame element holding a window, when the parent document is reachable. */
export function frameElementOf(win: Window): HTMLElement | null {
  try {
    const frame = win.frameElement;
    return isHtml(frame) ? frame : null;
  } catch {
    return null;
  }
}

/** True when any part of the element's box is inside the viewport. The same test the enumerators mark `o` from. */
export function inViewport(el: Element, win: Window): boolean {
  const rect = viewportRect(el, win);
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.bottom > 0 && rect.top < win.innerHeight && rect.right > 0 && rect.left < win.innerWidth;
}

/**
 * Bring one element to the middle of the viewport and resolve once the page
 * has stopped moving: smoothly, or at once under prefers-reduced-motion.
 * Called only from a Tab on the scroll banner. Nothing else on the page is
 * touched; focus stays where it was.
 */
export function scrollToTarget(el: Element, win: Window): Promise<void> {
  const reduced = typeof win.matchMedia === 'function' && win.matchMedia(REDUCED_MOTION).matches;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'instant' : 'smooth' });
  }
  return settled(win);
}

function settled(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let quiet = win.setTimeout(done, SCROLL_SETTLE_MS);
    const cap = win.setTimeout(done, SCROLL_MAX_MS);
    const onScroll = (): void => {
      win.clearTimeout(quiet);
      quiet = win.setTimeout(done, SCROLL_SETTLE_MS);
    };
    win.addEventListener('scroll', onScroll, { capture: true, passive: true });
    function done(): void {
      win.clearTimeout(quiet);
      win.clearTimeout(cap);
      win.removeEventListener('scroll', onScroll, true);
      resolve();
    }
  });
}
