const OPTS: CheckVisibilityOptions = { checkOpacity: true, visibilityProperty: true };

/**
 * `checkVisibility` is missing in jsdom (and old Chromium), so fall back to a
 * computed-style walk up the ancestor chain. Layout-based checks are useless
 * there too: offsetParent is always null and every rect is zero.
 */
export function isVisible(el: Element, win: Window): boolean {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility(OPTS);
  for (let node: Element | null = el; node; node = node.parentElement) {
    if ((node as HTMLElement).hidden) return false;
    const cs = win.getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  }
  return true;
}
