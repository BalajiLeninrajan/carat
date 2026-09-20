/**
 * Caret's own surfaces on the page: the debug panel, and anything else that
 * mounts a shadow host the user can click. A click, a scroll or a keystroke
 * inside one of these is the user working caret, not the page, so the chip
 * must not read it as "the user moved on" and the scheduler must not count it
 * as a reason to ask again. The chip's own host is not registered here; it
 * checks for itself, because a click there accepts the offer.
 */
const surfaces = new Set<Element>();

/** Register a shadow host; the returned function unregisters it. */
export function registerSurface(host: Element): () => void {
  surfaces.add(host);
  return () => {
    surfaces.delete(host);
  };
}

/** For the tests, and for a content script that starts over. */
export function clearSurfaces(): void {
  surfaces.clear();
}

/** Whether a node sits inside one of caret's surfaces. */
export function inSurface(node: EventTarget | null): boolean {
  if (surfaces.size === 0 || !(node instanceof Node)) return false;
  for (const host of surfaces) if (host === node || host.contains(node)) return true;
  return false;
}

/**
 * Whether an event came out of one of caret's surfaces. A closed shadow root
 * retargets to its host, so the host is as deep as the path goes from
 * outside, which is exactly what needs matching.
 */
export function fromSurface(event: Event): boolean {
  if (surfaces.size === 0) return false;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) if (node instanceof Element && surfaces.has(node)) return true;
  return inSurface(event.target);
}
