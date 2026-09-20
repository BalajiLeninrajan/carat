import type { GhostField } from './field';

/**
 * Where the grey text was drawn and with what. The shadow root is closed, so
 * this is how the tests read the overlay back.
 */
export interface GhostPlacement {
  /** `mirror` copies a native control's box and text; `caret` sits on the caret's own rect. */
  mode: 'mirror' | 'caret';
  left: number;
  top: number;
  width: number;
  height: number;
  font: string;
  /** The field's own scroll, which the mirror shifts its content by. */
  scrollLeft: number;
  scrollTop: number;
}

export interface GhostView {
  show(field: GhostField, prefix: string, suffix: string, text: string): void;
  hide(): void;
  readonly visible: boolean;
  /** The grey text on screen. */
  readonly text: string;
  readonly placement: GhostPlacement | null;
  destroy(): void;
}

/** Above the page, below the action chip, and never in the way of a click. */
const OVERLAY_CSS = `
:host { all: initial; }
.layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483645;
  contain: layout style;
}
.mirror {
  position: absolute;
  overflow: hidden;
  box-sizing: border-box;
  pointer-events: none;
  background: transparent;
  color: transparent;
  -webkit-text-fill-color: transparent;
}
.shift { display: block; }
.ghost {
  color: rgba(120, 120, 128, 0.85);
  -webkit-text-fill-color: rgba(120, 120, 128, 0.85);
}
.caret {
  position: absolute;
  white-space: pre;
  pointer-events: none;
  color: rgba(120, 120, 128, 0.85);
  -webkit-text-fill-color: rgba(120, 120, 128, 0.85);
}
`;

/**
 * Properties the mirror has to copy for the grey text to land where the
 * field's own caret would put it. Anything that moves a glyph sideways or
 * down belongs here.
 */
const COPIED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textIndent',
  'textTransform',
  'textAlign',
  'direction',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
] as const;

/**
 * The grey continuation, drawn over the page rather than into it. A native
 * control gets a mirror: a box with the same font, padding, border and scroll
 * as the field, holding the field's own text made transparent and the ghost
 * after it, so the ghost falls exactly where the next character would. An
 * editor gets a span on the caret's rect instead, which keeps the page's DOM
 * and its undo history untouched: nothing is ever inserted to make room.
 */
export function createGhostView(doc: Document = document): GhostView {
  const host = doc.createElement('div');
  host.setAttribute('data-carat-ghost', '');
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = OVERLAY_CSS;
  const layer = doc.createElement('div');
  layer.className = 'layer';
  root.append(style, layer);

  let placement: GhostPlacement | null = null;
  let shown = '';
  let attached = false;

  function attach(): void {
    if (attached) return;
    doc.body?.appendChild(host);
    attached = true;
  }

  function mirror(field: GhostField, prefix: string, suffix: string, text: string): void {
    const el = field.el;
    const win = doc.defaultView;
    const rect = el.getBoundingClientRect();
    const computed = win ? win.getComputedStyle(el) : null;
    const box = doc.createElement('div');
    box.className = 'mirror';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    // An input holds one line and scrolls sideways; a textarea wraps like the mirror does.
    box.style.whiteSpace = field.kind === 'input' ? 'pre' : 'pre-wrap';
    box.style.overflowWrap = 'break-word';
    box.style.borderStyle = 'solid';
    box.style.borderColor = 'transparent';
    if (computed) for (const key of COPIED) box.style[key] = computed[key];

    const shift = doc.createElement('span');
    shift.className = 'shift';
    shift.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
    const before = doc.createElement('span');
    before.textContent = prefix;
    const ghost = doc.createElement('span');
    ghost.className = 'ghost';
    ghost.textContent = text;
    const after = doc.createElement('span');
    after.textContent = suffix;
    shift.append(before, ghost, after);
    box.append(shift);
    layer.replaceChildren(box);

    placement = {
      mode: 'mirror',
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      font: fontOf(box.style, computed),
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
  }

  function atCaret(field: GhostField, text: string): void {
    const win = doc.defaultView;
    const rect = caretRect(field.el, doc) ?? field.el.getBoundingClientRect();
    const computed = win ? win.getComputedStyle(field.el) : null;
    const span = doc.createElement('span');
    span.className = 'caret';
    span.textContent = text;
    span.style.left = `${rect.right}px`;
    span.style.top = `${rect.top}px`;
    if (computed) {
      span.style.fontFamily = computed.fontFamily;
      span.style.fontSize = computed.fontSize;
      span.style.fontWeight = computed.fontWeight;
      span.style.fontStyle = computed.fontStyle;
      span.style.letterSpacing = computed.letterSpacing;
      span.style.lineHeight = computed.lineHeight;
    }
    layer.replaceChildren(span);
    placement = {
      mode: 'caret',
      left: rect.right,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      font: fontOf(span.style, computed),
      scrollLeft: 0,
      scrollTop: 0,
    };
  }

  return {
    show(field, prefix, suffix, text) {
      attach();
      shown = text;
      if (field.kind === 'editable') atCaret(field, text);
      else mirror(field, prefix, suffix, text);
    },
    hide() {
      shown = '';
      placement = null;
      layer.replaceChildren();
    },
    get visible() {
      return shown !== '';
    },
    get text() {
      return shown;
    },
    get placement() {
      return placement;
    },
    destroy() {
      shown = '';
      placement = null;
      host.remove();
      attached = false;
    },
  };
}

/**
 * The caret's own box in an editor. A collapsed range has no client rect in
 * some engines, so the last character's box stands in, and the element's own
 * box behind that.
 */
export function caretRect(el: Element, doc: Document): DOMRect | null {
  const sel = doc.defaultView?.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  const direct = range.getClientRects?.();
  if (direct && direct.length > 0) return direct[0]!;
  const own = range.getBoundingClientRect?.();
  if (own && (own.width > 0 || own.height > 0 || own.top !== 0)) return own;
  return null;
}

function fontOf(style: CSSStyleDeclaration, computed: CSSStyleDeclaration | null): string {
  const size = style.fontSize || computed?.fontSize || '';
  const family = style.fontFamily || computed?.fontFamily || '';
  const weight = style.fontWeight || computed?.fontWeight || '';
  return `${weight} ${size} ${family}`.trim();
}
