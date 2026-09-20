import type { GhostInput, GhostReply } from '../background/ghost';
import { deepActiveElement } from '../chip/keys';
import type { ScriptContext } from '../content/context';
import { send } from '../content/send';
import { acceptGhost } from './accept';
import type { GhostField, Measure } from './field';
import { createMeasure, eligible, fieldName, ghostField, hasRoom, materiallyChanged, readField } from './field';
import type { GhostView } from './view';
import { createGhostView } from './view';

export { acceptGhost } from './accept';
export { createGhostView, caretRect } from './view';
export type { GhostPlacement, GhostView } from './view';
export {
  MIN_ROOM_PX,
  RESUME_CHARS,
  caretOf,
  createMeasure,
  eligible,
  fieldName,
  ghostField,
  hasRoom,
  materiallyChanged,
  readField,
} from './field';
export type { FieldText, GhostField, Measure } from './field';

export const GHOST_TIMING = {
  /** A pause in typing this long is what asks for a continuation. */
  pauseMs: 350,
} as const;

/** Keys that are not the user typing and do not put the ghost away. */
const HELD = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'OS', 'Dead']);

export interface GhostHandle {
  /** Grey text is on screen, so Tab belongs to the ghost and the action chip stays off. */
  readonly visible: boolean;
  /** The control the grey text is drawn in, or null. */
  readonly field: Element | null;
  /** The grey text; the shadow root is closed, so tests read it here. */
  readonly text: string;
  /** The user typed: the ghost on screen goes, and another is asked for after the pause. */
  typed(): void;
  /** The focus moved: any ghost goes with it. */
  focused(): void;
  /** The outline the action path just built here, so the ghost's question carries the same page. */
  noteOutline(outline: string): void;
  drop(): void;
  destroy(): void;
}

export interface GhostOptions {
  /** Overridden in tests; by default the `ghost` message to the background. */
  ask?(input: GhostInput): Promise<GhostReply | undefined>;
  /** Overridden in tests; by default a canvas. */
  measure?: Measure;
  view?: GhostView;
  /**
   * The model had nothing to continue, so Tab is the action chip's again and
   * the page is owed one. Wired to the action scheduler's `refresh`.
   */
  onIdle?(): void;
}

const NO_GHOST: GhostHandle = {
  visible: false,
  field: null,
  text: '',
  typed: () => undefined,
  focused: () => undefined,
  noteOutline: () => undefined,
  drop: () => undefined,
  destroy: () => undefined,
};

/**
 * Grey text after the caret, the other half of Tab. The user pauses in a
 * field, the model is asked what they were going to write, and the first
 * token is on screen before the last one is written. Tab takes it, any other
 * key drops it, and Esc drops it and stays out of that field until what is in
 * it has actually changed.
 *
 * While the grey text is up, Tab is the ghost's: the keydown listener sits on
 * the window in the capture phase and stops the event dead, and the action
 * chip is kept off the field by the scheduler. An empty answer is the signal
 * that Tab belongs to the chip again.
 */
export function startGhost(ctx: ScriptContext, doc: Document = document, opts: GhostOptions = {}): GhostHandle {
  const win = doc.defaultView;
  if (!win) return NO_GHOST;

  const view = opts.view ?? createGhostView(doc);
  const measure = opts.measure ?? createMeasure(doc);
  const ask = opts.ask ?? ((input: GhostInput) => send('ghost', input));

  /** What each field held when Esc was pressed in it; cleared once it has moved on. */
  const refused = new WeakMap<Element, string>();
  let shown: { field: GhostField; prefix: string; suffix: string; text: string } | null = null;
  let outline = '';
  let seq = 0;
  let timer: number | null = null;

  function cancelPause(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** Whatever is on screen goes, and whatever is in flight stops counting. */
  function drop(): void {
    seq++;
    cancelPause();
    if (!shown) return;
    shown = null;
    view.hide();
  }

  function suppress(): void {
    if (!shown) return;
    refused.set(shown.field.el, shown.prefix + shown.suffix);
    drop();
  }

  function accept(): void {
    if (!shown) return;
    const { field, text } = shown;
    drop();
    // The value is about to move, so an earlier Esc in this field is spent.
    refused.delete(field.el);
    acceptGhost(field, text);
  }

  /** The field the user is in right now, when it is one a ghost may go in. */
  function current(): GhostField | null {
    return ghostField(deepActiveElement(doc));
  }

  function suppressed(el: Element, value: string): boolean {
    const at = refused.get(el);
    if (at === undefined) return false;
    if (!materiallyChanged(value, at)) return true;
    refused.delete(el);
    return false;
  }

  function schedule(): void {
    cancelPause();
    timer = ctx.setTimeout(() => {
      timer = null;
      void run();
    }, GHOST_TIMING.pauseMs);
  }

  async function run(): Promise<void> {
    const field = current();
    if (!field) return;
    const text = readField(field, doc);
    if (!text || !eligible(field, text)) return;
    if (suppressed(field.el, text.prefix + text.suffix)) return;
    const font = fontOf(field.el);
    if (!hasRoom(field, text.prefix + text.suffix, font, measure)) return;

    const mine = ++seq;
    const id = `${mine}-${Date.now()}`;
    const name = fieldName(field.el);
    let have: number | null = null;
    for (;;) {
      const reply = await ask({
        id,
        prefix: text.prefix,
        ...(text.suffix ? { suffix: text.suffix } : {}),
        outline,
        ...(name ? { field: name } : {}),
        singleLine: text.singleLine,
        ...(have === null ? {} : { have }),
      });
      if (!reply || mine !== seq || !ctx.isValid) return;
      have = reply.text.length;
      if (reply.text.trim() !== '' && current()?.el === field.el) {
        shown = { field, prefix: text.prefix, suffix: text.suffix, text: reply.text };
        view.show(field, text.prefix, text.suffix, reply.text);
      }
      if (!reply.more) break;
    }
    // Nothing to continue: the keystroke goes back to the next-action path.
    if (!shown) opts.onIdle?.();
  }

  function fontOf(el: Element): string {
    const computed = win!.getComputedStyle(el);
    return `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`.trim();
  }

  /** The field scrolled or the page moved under it; the grey text follows rather than vanishing. */
  function reposition(): void {
    if (!shown) return;
    view.show(shown.field, shown.prefix, shown.suffix, shown.text);
  }

  const onKeydown = (e: KeyboardEvent): void => {
    if (!shown) return;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      // The chip listens on this window too; while a ghost is up, Tab is not its.
      e.stopImmediatePropagation();
      accept();
      return;
    }
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      suppress();
      return;
    }
    if (HELD.has(e.key)) return;
    drop();
  };

  ctx.addEventListener(win, 'keydown', onKeydown as EventListener, true);
  ctx.addEventListener(win, 'pointerdown', (() => drop()) as EventListener, true);
  ctx.addEventListener(win, 'scroll', reposition as EventListener, { capture: true, passive: true } as AddEventListenerOptions);
  ctx.addEventListener(win, 'resize', reposition as EventListener, { passive: true } as AddEventListenerOptions);

  ctx.onInvalidated(() => view.destroy());

  return {
    get visible() {
      return shown !== null;
    },
    get field() {
      return shown?.field.el ?? null;
    },
    get text() {
      return shown?.text ?? '';
    },
    typed() {
      drop();
      if (current()) schedule();
    },
    focused() {
      drop();
    },
    noteOutline(next) {
      outline = next;
    },
    drop,
    destroy() {
      drop();
      view.destroy();
    },
  };
}
