import type { ScriptContext } from '../content/context';
import { isSecretField } from '../dom/secret';
import { isInput, isTextArea } from '../dom/tags';
import { accessibleName, roleOf } from '../interact';
import type { HistoryEntry } from './entries';
import { shortName, shortValue } from './entries';

export const HISTORY_TIMING = {
  /** A typing burst becomes one entry this long after the last keystroke. */
  typeDebounceMs: 900,
} as const;

/** How far up from the click target a role is looked for. */
const CLICK_CLIMB = 5;

export interface HistoryRecorderOptions {
  /** Where a finished entry goes: the background, over the `history` message. */
  emit: (entry: HistoryEntry) => void;
  now?: () => number;
}

export interface HistoryRecorder {
  /** Finish any typing burst still in flight. */
  flush(): void;
  stop(): void;
}

/**
 * The content script's half of the timeline: what the user clicked and what
 * they typed, on the page carat is watching. Values from password, card and
 * code fields never leave the page, and a field with no name is not recorded
 * at all. Carat's own accepts and dismissals, and every navigation, are
 * recorded in the background instead, where they are known for certain.
 */
export function startHistoryRecorder(ctx: ScriptContext, doc: Document, opts: HistoryRecorderOptions): HistoryRecorder {
  const now = opts.now ?? (() => Date.now());
  let pending: { el: Element; name: string; value: string } | null = null;
  let timer: number | null = null;
  let stopped = false;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const burst = pending;
    pending = null;
    if (!burst || stopped) return;
    opts.emit({ t: now(), kind: 'type', name: burst.name, value: burst.value });
  };

  const onClick = (e: Event): void => {
    if (stopped || !ctx.isValid) return;
    const target = e.target;
    if (!target || !(target as Element).closest) return;
    let node: Element | null = target as Element;
    for (let depth = 0; node && depth < CLICK_CLIMB; depth++, node = node.parentElement) {
      const role = roleOf(node);
      if (!role) continue;
      const name = shortName(accessibleName(node, node.ownerDocument));
      if (!name) return;
      // A click ends whatever was being typed, and lands after it.
      flush();
      opts.emit({ t: now(), kind: 'click', role, name });
      return;
    }
  };

  const onInput = (e: Event): void => {
    if (stopped || !ctx.isValid) return;
    const el = e.target as Element | null;
    if (!el || !editable(el)) return;
    const name = shortName(accessibleName(el, el.ownerDocument) || placeholderOf(el));
    if (!name) return;
    if (pending && pending.el !== el) flush();
    pending = { el, name, value: isSecretField(el, name) ? '' : shortValue(valueOf(el)) };
    if (timer !== null) clearTimeout(timer);
    timer = ctx.setTimeout(flush, HISTORY_TIMING.typeDebounceMs);
  };

  ctx.addEventListener(doc, 'click', onClick, true);
  ctx.addEventListener(doc, 'input', onInput, true);
  ctx.addEventListener(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'hidden') flush();
  });
  ctx.onInvalidated(() => stop());

  function stop(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
    stopped = true;
  }

  return { flush, stop };
}

function editable(el: Element): boolean {
  if (isInput(el)) return el.type !== 'hidden';
  if (isTextArea(el)) return true;
  return el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true';
}

function valueOf(el: Element): string {
  if (isInput(el) || isTextArea(el)) return el.value;
  return el.textContent ?? '';
}

function placeholderOf(el: Element): string {
  return el.getAttribute('placeholder') ?? '';
}
