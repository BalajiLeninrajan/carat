import { isHtml } from '../dom/tags';

/**
 * Resolve with the first non-null result of `check`, re-run on every DOM
 * change and on a short interval (for widgets that flip a class without a
 * mutation the observer sees), or with null once `capMs` has passed. Timers
 * come from the document's window so fake timers in tests reach them.
 */
export function waitFor<T>(doc: Document, check: () => T | null, capMs: number, pollMs = 50): Promise<T | null> {
  const win = doc.defaultView ?? window;
  return new Promise((resolve) => {
    const first = check();
    if (first !== null) {
      resolve(first);
      return;
    }
    let done = false;
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(look) : null;
    observer?.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-hidden', 'hidden', 'class', 'style'] });
    const poll = win.setInterval(look, pollMs);
    const cap = win.setTimeout(() => finish(null), capMs);
    function look(): void {
      if (done) return;
      const found = check();
      if (found !== null) finish(found);
    }
    function finish(value: T | null): void {
      if (done) return;
      done = true;
      observer?.disconnect();
      win.clearInterval(poll);
      win.clearTimeout(cap);
      resolve(value);
    }
  });
}

/** One macrotask, for a widget to react to a click before its state is read. */
export function tick(doc: Document, ms = 0): Promise<void> {
  const win = doc.defaultView ?? window;
  return new Promise((resolve) => win.setTimeout(resolve, ms));
}

const KEY_CODES: Record<string, number> = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27 };

/** keydown then keyup, the way a widget listening for keyboard navigation expects. */
export function pressKey(el: Element, key: string): void {
  for (const type of ['keydown', 'keyup'] as const) {
    el.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: KEY_CODES[key], bubbles: true, cancelable: true }));
  }
}

/** The whole pointer sequence: custom listboxes and cards often act on mousedown, not click. */
export function pressPointer(el: Element): void {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup'] as const) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true }));
  }
  if (isHtml(el)) el.click();
  else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
}
