import { isHtml, isSelect } from '../dom/tags';
import { deepActiveElement, isTextEntry } from '../chip/keys';
import { fillTextControl, isContentEditable, isTextControl } from '../fill';
import type { Undo } from '../interact';
import type { ScriptContext } from './context';

export const UNDO_TIMING = {
  /**
   * How long after a Tab the undo key is carat's. Long enough to notice the
   * wrong field filled, short enough that the key belongs to the page again
   * before the user has moved on to anything else.
   */
  windowMs: 5000,
} as const;

/** The hint the chip carries while the window is open, in the platform's own words. */
export function undoHint(nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator): string {
  return isMac(nav) ? '⌘Z to undo' : 'Ctrl+Z to undo';
}

function isMac(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  const text = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /mac|iphone|ipad|ipod/i.test(text);
}

/**
 * The platform's own undo chord and nothing near it: Cmd+Z on a Mac, Ctrl+Z
 * everywhere else. Shift makes it redo, which carat has no business taking.
 */
export function isUndoKey(e: KeyboardEvent, nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator): boolean {
  if (e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey) return false;
  return isMac(nav) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** One action's way back, waiting for the key. */
export interface PendingUndo {
  /**
   * The control carat acted on, when there was one. The undo key is taken
   * inside it even though it is a text field: carat's own write is the only
   * thing in that field's undo stack that the user did not put there.
   */
  el?: Element | null;
  /** The clause the timeline line is built from: `fill "Search"`. */
  what: string;
  run: Undo;
}

export interface UndoDesk {
  /** Arm the window for one action; whatever was armed before is dropped. */
  offer(undo: PendingUndo): void;
  /** A keydown from the page. True when the key was carat's and the undo has started. */
  handle(e: KeyboardEvent): boolean;
  clear(): void;
  readonly armed: boolean;
}

export interface UndoDeskOptions {
  /** Called once the undo has run, with the clause for the timeline. */
  onUndone(what: string): void;
  now?: () => number;
  windowMs?: number;
  nav?: { platform?: string; userAgent?: string };
}

/**
 * The five seconds after a Tab in which Ctrl+Z means "not that after all".
 * One action at a time: the next Tab replaces what is armed, because only the
 * last thing carat did is the thing the user is reacting to.
 */
export function createUndoDesk(ctx: ScriptContext, doc: Document, opts: UndoDeskOptions): UndoDesk {
  const now = opts.now ?? (() => Date.now());
  const windowMs = opts.windowMs ?? UNDO_TIMING.windowMs;
  let pending: PendingUndo | null = null;
  let armedAt = 0;
  let timer: number | null = null;

  function clear(): void {
    pending = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  return {
    offer(undo: PendingUndo) {
      clear();
      pending = undo;
      armedAt = now();
      timer = ctx.setTimeout(clear, windowMs);
    },
    clear,
    get armed() {
      return pending !== null;
    },
    handle(e: KeyboardEvent): boolean {
      const undo = pending;
      if (!undo || e.isComposing) return false;
      // The window is checked here too: a fake clock in a test moves without the timer.
      if (now() - armedAt >= windowMs) {
        clear();
        return false;
      }
      if (!isUndoKey(e, opts.nav ?? globalThis.navigator)) return false;
      // A text field the user is in has an undo stack of its own; that key is theirs.
      if (defersToPage(doc, undo.el ?? null)) return false;
      e.preventDefault();
      e.stopImmediatePropagation();
      clear();
      void Promise.resolve()
        .then(() => undo.run())
        .then(() => opts.onUndone(undo.what))
        .catch(() => undefined);
      return true;
    },
  };
}

/** Whether the focused control owns the undo key, rather than carat. */
export function defersToPage(doc: Document, acted: Element | null): boolean {
  const active = deepActiveElement(doc);
  if (!isTextEntry(active)) return false;
  if (!acted || !active) return true;
  return active !== acted && !acted.contains(active);
}

/**
 * The way back out of a fill: the value the control held, put back with the
 * same events the fill itself fired, so a framework sees it as typing. Null
 * when nothing on the element holds a value.
 */
export function fillUndo(el: Element): Undo | undefined {
  const target = valueTarget(el);
  if (!target) return undefined;
  if (isSelect(target)) {
    const index = target.selectedIndex;
    return async () => {
      if (target.selectedIndex === index) return;
      target.selectedIndex = index;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    };
  }
  if (isTextControl(target)) {
    const before = target.value;
    return async () => {
      if (target.value !== before) fillTextControl(target, before);
    };
  }
  if (!isContentEditable(target)) return undefined;
  const editable = target;
  const before = editable.textContent ?? '';
  return async () => {
    if ((editable.textContent ?? '') === before) return;
    // Written, not inserted: the fill's own path appends at the caret, and
    // what this has to do is put the box back to the text it had.
    editable.textContent = before;
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: before }));
    editable.dispatchEvent(new Event('change', { bubbles: true }));
  };
}

const INNER_CONTROL = 'input, textarea, [contenteditable]:not([contenteditable=false])';

/**
 * The control a fill would actually write into. Mirrors the fill's own pick:
 * a `role=combobox` is often a wrapper around the real input, and the value
 * that has to be put back is the inner one's.
 */
function valueTarget(el: Element): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | Element | null {
  if (isTextControl(el) || isSelect(el)) return el;
  if (isHtml(el) && el.getAttribute('contenteditable') !== null) {
    return el.getAttribute('contenteditable') === 'false' ? null : el;
  }
  const inner = el.querySelector(INNER_CONTROL);
  if (inner) return inner;
  return isContentEditable(el) ? el : null;
}

/** Put the window back where it was; instant, because a glide back reads as the page moving on its own. */
export function scrollUndo(win: Window, from: { x: number; y: number }): Undo {
  return async () => {
    if (typeof win.scrollTo === 'function') win.scrollTo({ top: from.y, left: from.x, behavior: 'auto' });
  };
}
