import { isHtml } from '../dom/tags';

/** Scroll events this far apart mean the smooth scroll has stopped. */
export const SCROLL_SETTLE_MS = 120;
/** However long the page keeps scrolling, the chip follows after this. */
export const SCROLL_MAX_MS = 1000;
/** An instant scroll fires one event on the next frame; past this, it fired none. */
export const INSTANT_SCROLL_CAP_MS = 50;

export interface ScrollOptions {
  /** Jump rather than glide: a repeated tap, where the glide is the whole wait. */
  instant?: boolean;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Scrolls carat started that have not stopped yet. */
let running = 0;
/** The tail after the last of them: frames still landing once the settle has resolved. */
let tail: number | null = null;
/** Waiting for the mark to come off, so the page is read after it has stopped moving. */
let waiting: Array<() => void> = [];

/**
 * Whether the page is moving because carat moved it. A smooth scroll of one
 * viewport takes longer than the window it is measured with, so the mark
 * stands from the first pixel to a settle window past the last. A scroll
 * event while it stands is not the user reading on: it neither dismisses the
 * chip nor counts as the user acting.
 */
export function caratScrolling(): boolean {
  return running > 0 || tail !== null;
}

/**
 * Resolves the moment the mark comes off, or at once when it is not on. The
 * question after a scroll carat performed waits on this rather than on a
 * timer: the outline read while the page is still moving is the old one.
 */
export function caratScrollEnd(): Promise<void> {
  if (!caratScrolling()) return Promise.resolve();
  return new Promise((resolve) => {
    waiting.push(resolve);
  });
}

/** The mark is off; whoever was waiting for the page to stop may read it now. */
function release(): void {
  const woken = waiting;
  waiting = [];
  for (const resolve of woken) resolve();
}

/**
 * Run a scroll of carat's own under that mark. A glide is watched until its
 * events stop, then held for one more settle window for the frames still
 * landing. A jump fires one event on the next frame and is over: the mark
 * comes off as soon as that event has been heard, or after a short cap when
 * the page had nowhere to go, so a repeated tap is not made to wait out a
 * settle that has nothing to settle.
 */
function own(win: Window, start: () => void, instant = false): Promise<void> {
  running++;
  if (tail !== null) {
    win.clearTimeout(tail);
    tail = null;
  }
  start();
  if (instant) return jumped(win).then(() => {
    running--;
    if (running === 0) release();
  });
  return settled(win).then(() => {
    running--;
    if (running > 0) return;
    tail = win.setTimeout(() => {
      tail = null;
      release();
    }, SCROLL_SETTLE_MS);
  });
}

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

/** Pixels of slack before the page counts as having more below: a sticky footer is not new content. */
export const MORE_SLACK_PX = 32;

/** True when any part of the element's box is inside the viewport. The same test the enumerators mark `o` from. */
export function inViewport(el: Element, win: Window): boolean {
  const rect = viewportRect(el, win);
  if (rect.width <= 0 || rect.height <= 0) return false;
  return rect.bottom > 0 && rect.top < win.innerHeight && rect.right > 0 && rect.left < win.innerWidth;
}

/**
 * Bring one element to the middle of the viewport and resolve once the page
 * has stopped moving: smoothly, or at once under prefers-reduced-motion.
 * Called only from an accepted scroll banner. Nothing else on the page is
 * touched; focus stays where it was.
 */
export function scrollToTarget(el: Element, win: Window, opts: ScrollOptions = {}): Promise<void> {
  const instant = opts.instant === true || prefersReducedMotion(win);
  return own(
    win,
    () => {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: instant ? 'instant' : 'smooth' });
      }
    },
    instant,
  );
}

/**
 * Move the page one viewport down and resolve once it has stopped: the whole
 * of the `Scroll down` offer. Smooth, or instant under
 * prefers-reduced-motion. Focus stays where it was and nothing is clicked.
 */
export function scrollPageDown(win: Window, opts: ScrollOptions = {}): Promise<void> {
  const instant = opts.instant === true || prefersReducedMotion(win);
  return own(
    win,
    () => {
      if (typeof win.scrollBy === 'function') {
        win.scrollBy({ top: win.innerHeight, left: 0, behavior: instant ? 'instant' : 'smooth' });
      }
    },
    instant,
  );
}

function prefersReducedMotion(win: Window): boolean {
  return typeof win.matchMedia === 'function' && win.matchMedia(REDUCED_MOTION).matches;
}

/** Resolves once the one event of a jump has been heard, or after the cap when none comes. */
function jumped(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let over = false;
    const finish = (): void => {
      if (over) return;
      over = true;
      win.clearTimeout(cap);
      win.removeEventListener('scroll', onScroll, true);
      resolve();
    };
    // The event is still dispatching when this runs; let it finish before the mark comes off.
    const onScroll = (): void => void win.setTimeout(finish, 0);
    const cap = win.setTimeout(finish, INSTANT_SCROLL_CAP_MS);
    win.addEventListener('scroll', onScroll, { capture: true, passive: true });
  });
}

/** The scrollable height of the document, never less than one viewport. */
export function documentHeight(win: Window, doc: Document): number {
  return Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0, win.innerHeight);
}

/** How far down the page the user is, and how tall it is, both in viewports to one decimal. */
export function viewportsOf(win: Window, doc: Document): { y: number; pages: number } {
  const vh = Math.max(1, win.innerHeight);
  const round = (n: number): number => Math.round(n * 10) / 10;
  return { y: round(win.scrollY / vh), pages: round(documentHeight(win, doc) / vh) };
}

/** Whether a viewport down would show anything that is not on screen now. */
export function hasMoreBelow(win: Window, doc: Document): boolean {
  return win.scrollY + win.innerHeight < documentHeight(win, doc) - MORE_SLACK_PX;
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
