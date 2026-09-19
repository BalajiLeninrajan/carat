/** Scroll events this far apart mean the smooth scroll has stopped. */
export const SCROLL_SETTLE_MS = 120;
/** However long the page keeps scrolling, the chip follows after this. */
export const SCROLL_MAX_MS = 1000;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** True when any part of the element's box is inside the viewport. The same test the enumerators mark `o` from. */
export function inViewport(el: Element, win: Window): boolean {
  const rect = el.getBoundingClientRect();
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
