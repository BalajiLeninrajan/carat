import { isSecretField } from '../dom/secret';
import { isHtml, isInput, isTextArea } from '../dom/tags';
import { isContentEditable } from '../fill/contenteditable';

/**
 * A control grey text can be drawn in. The three kinds are read and written
 * differently enough that everything downstream switches on this rather than
 * re-asking the DOM what it is looking at.
 */
export type GhostField =
  | { kind: 'input'; el: HTMLInputElement }
  | { kind: 'textarea'; el: HTMLTextAreaElement }
  | { kind: 'editable'; el: HTMLElement };

/** Input types that hold no free text, so there is nothing to continue. */
const NOT_TEXT = new Set([
  'button',
  'submit',
  'reset',
  'checkbox',
  'radio',
  'file',
  'range',
  'color',
  'image',
  'hidden',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
  'number',
]);

export function ghostField(el: Element | null): GhostField | null {
  if (!el) return null;
  if (isInput(el)) return NOT_TEXT.has(el.type.toLowerCase()) ? null : { kind: 'input', el };
  if (isTextArea(el)) return { kind: 'textarea', el };
  if (isHtml(el) && isContentEditable(el)) return { kind: 'editable', el };
  return null;
}

/** Where the caret is and what sits on either side of it. */
export interface FieldText {
  prefix: string;
  suffix: string;
  /** One line, so the continuation is capped harder and must not carry a newline. */
  singleLine: boolean;
}

/**
 * The text around the caret. Null when there is no caret to continue from: a
 * range the user has selected is an edit in progress, not a place to write.
 */
export function readField(field: GhostField, doc: Document = field.el.ownerDocument): FieldText | null {
  if (field.kind === 'editable') {
    const sel = doc.defaultView?.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!field.el.contains(range.startContainer)) return null;
    const before = doc.createRange();
    before.selectNodeContents(field.el);
    before.setEnd(range.startContainer, range.startOffset);
    const whole = field.el.textContent ?? '';
    const prefix = before.toString();
    return { prefix, suffix: whole.slice(prefix.length), singleLine: false };
  }
  const el = field.el;
  const value = el.value;
  const start = caretStart(el);
  const end = caretEnd(el);
  if (start !== null && end !== null && start !== end) return null;
  const caret = start ?? value.length;
  return { prefix: value.slice(0, caret), suffix: value.slice(caret), singleLine: field.kind === 'input' };
}

function caretStart(el: HTMLInputElement | HTMLTextAreaElement): number | null {
  try {
    return el.selectionStart;
  } catch {
    // email and number inputs throw rather than answer; the caret is at the end of what they hold.
    return null;
  }
}

function caretEnd(el: HTMLInputElement | HTMLTextAreaElement): number | null {
  try {
    return el.selectionEnd;
  } catch {
    return null;
  }
}

/** Where the caret sits in a native control, for putting it back after an accept. */
export function caretOf(el: HTMLInputElement | HTMLTextAreaElement): number | null {
  return caretStart(el);
}

/** Pixels of room a one-line field must still have before grey text is worth drawing. */
export const MIN_ROOM_PX = 8;

/** Measures a run of text at a font, or answers null where nothing can measure it. */
export type Measure = (text: string, font: string) => number | null;

/**
 * A canvas measurer, or one that always answers null. Null is read as "room
 * enough": a browser that will not measure must not silently switch the ghost
 * off.
 */
export function createMeasure(doc: Document): Measure {
  let ctx: CanvasRenderingContext2D | null | undefined;
  return (text, font) => {
    if (ctx === undefined) {
      try {
        ctx = doc.createElement('canvas').getContext('2d');
      } catch {
        ctx = null;
      }
    }
    if (!ctx) return null;
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

/**
 * Whether the field has anywhere left to put the grey text. Only a one-line
 * input can run out: a textarea and an editor wrap, so there is always another
 * line. Null from the measurer means room enough.
 */
export function hasRoom(field: GhostField, text: string, font: string, measure: Measure): boolean {
  if (field.kind !== 'input') return true;
  const width = measure(text, font);
  if (width === null) return true;
  return field.el.clientWidth - width >= MIN_ROOM_PX;
}

/**
 * Whether this field may carry a ghost at all, before anything is asked of
 * the model: not a secret, not empty (there Tab still belongs to the action
 * chip), and something to continue from.
 */
export function eligible(field: GhostField, text: FieldText): boolean {
  if (isSecretField(field.el, field.el.getAttribute('aria-label') ?? '')) return false;
  if ((text.prefix + text.suffix).trim() === '') return false;
  if (text.prefix.trim() === '') return false;
  // Accepting in an editor goes in at the caret through the browser's own
  // editing pipeline, which puts the caret at the end first; mid-text there
  // would insert in the wrong place, so that case is left alone.
  if (field.kind === 'editable' && text.suffix !== '') return false;
  return true;
}

/** The field's accessible name, for the model's sake. Never its value. */
export function fieldName(el: Element): string {
  const label = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '';
  return label.trim().slice(0, 60);
}

/** Characters the value must move by before an Esc stops suppressing this field. */
export const RESUME_CHARS = 4;

/**
 * Whether the field has changed enough since Esc for the ghost to come back.
 * Typing one more character is the same thought, and the user just said no to
 * it; editing what was already there, or adding a real amount more, is not.
 */
export function materiallyChanged(now: string, at: string): boolean {
  if (now === at) return false;
  let shared = 0;
  while (shared < now.length && shared < at.length && now[shared] === at[shared]) shared++;
  if (shared < at.length) return true;
  return now.length - at.length >= RESUME_CHARS;
}
