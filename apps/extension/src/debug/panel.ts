import { registerSurface } from '../dom/surfaces';
import { DEBUG_CSS } from './styles';
import type { DebugView, GateRow } from './view';

const HOST_ATTR = 'data-caret-debug';

export const PANEL_SIZE = {
  width: 440,
  height: 380,
  minWidth: 300,
  minHeight: 180,
  /** The panel never takes more than this much of the window's height. */
  maxHeightRatio: 0.45,
  /** Clear of the status pill on the left and the banner in the middle. */
  inset: 12,
} as const;

export interface DebugPanel {
  open(): void;
  close(): void;
  /** Alt+Shift+D, both ways. Returns whether it is open afterwards. */
  toggle(): boolean;
  /** Draw a view; ignored while closed. */
  render(view: DebugView): void;
  destroy(): void;
  readonly visible: boolean;
  /** The words in the panel; the shadow root is closed, so tests read them here. */
  readonly text: string;
  /** Keystrokes the panel's own handler saw. The page's Tab must never reach it. */
  readonly keys: number;
}

export interface DebugPanelOptions {
  /** The panel closed itself: Esc, or the header's button. */
  onClose?: () => void;
  /** The copy button was pressed; the panel hands over the text to put on the clipboard. */
  onCopy?: (text: string) => void;
}

/**
 * What caret is thinking about this page, in a shadow host of its own at the
 * bottom right: the request as it was sent, the answer as it came back, the
 * timeline both sides wrote, and the gate in front of the next request.
 *
 * It is registered as one of caret's surfaces, so a click inside it is not
 * the user getting on with the page and never takes the chip down. Its only
 * key listener is on its own host, so Tab and Esc reach it when the panel has
 * focus and never when the page does.
 */
export function createDebugPanel(doc: Document = document, opts: DebugPanelOptions = {}): DebugPanel {
  const win = doc.defaultView ?? window;
  const host = doc.createElement('div');
  host.setAttribute(HOST_ATTR, '');
  host.tabIndex = 0;
  host.style.cssText = `all:initial;position:fixed;z-index:2147483645;display:none;box-sizing:border-box;`;
  const root = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = DEBUG_CSS;
  const panel = doc.createElement('div');
  panel.className = 'panel';

  const head = doc.createElement('div');
  head.className = 'head';
  const title = el(doc, 'span', 'title', 'caret debug');
  const where = el(doc, 'span', 'where', '');
  const copy = doc.createElement('button');
  copy.type = 'button';
  copy.textContent = 'copy request';
  const shut = doc.createElement('button');
  shut.type = 'button';
  shut.textContent = 'close';
  head.append(title, where, copy, shut);

  const body = doc.createElement('div');
  body.className = 'body';
  const grip = doc.createElement('div');
  grip.className = 'grip';
  panel.append(head, body);
  root.append(style, panel, grip);

  let open = false;
  let keys = 0;
  let json = '';
  let unregister: (() => void) | null = null;
  interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
  }
  let box: Box = { left: 0, top: 0, width: PANEL_SIZE.width, height: PANEL_SIZE.height };

  function maxHeight(): number {
    return Math.max(PANEL_SIZE.minHeight, Math.round(viewport().h * PANEL_SIZE.maxHeightRatio));
  }

  function viewport(): { w: number; h: number } {
    return { w: win.innerWidth || 1024, h: win.innerHeight || 768 };
  }

  /** Bottom right, clear of the window's edges, never taller than the rule allows. */
  function place(): void {
    const { w, h } = viewport();
    box.width = clamp(box.width, PANEL_SIZE.minWidth, Math.max(PANEL_SIZE.minWidth, w - 2 * PANEL_SIZE.inset));
    box.height = clamp(box.height, PANEL_SIZE.minHeight, maxHeight());
    box.left = clamp(box.left, 0, Math.max(0, w - box.width));
    box.top = clamp(box.top, 0, Math.max(0, h - box.height));
    host.style.left = `${Math.round(box.left)}px`;
    host.style.top = `${Math.round(box.top)}px`;
    host.style.width = `${Math.round(box.width)}px`;
    host.style.height = `${Math.round(box.height)}px`;
  }

  function corner(): void {
    const { w, h } = viewport();
    box = {
      width: Math.min(PANEL_SIZE.width, Math.max(PANEL_SIZE.minWidth, w - 2 * PANEL_SIZE.inset)),
      height: Math.min(PANEL_SIZE.height, maxHeight()),
      left: 0,
      top: 0,
    };
    box.left = w - box.width - PANEL_SIZE.inset;
    box.top = h - box.height - PANEL_SIZE.inset;
    place();
  }

  /**
   * Dragging, by the header to move and by the corner grip to resize. Mouse
   * events rather than pointer capture: the listeners come off on mouseup,
   * and caret's own surfaces are ignored by the chip, so none of this reads
   * as the user acting on the page.
   */
  function startDrag(e: MouseEvent, mode: 'move' | 'resize'): void {
    e.preventDefault();
    host.focus();
    const from = { x: e.clientX, y: e.clientY, ...box };
    const onMove = (m: MouseEvent): void => {
      const dx = m.clientX - from.x;
      const dy = m.clientY - from.y;
      if (mode === 'move') {
        box.left = from.left + dx;
        box.top = from.top + dy;
      } else {
        // The grip is the top-left corner: the bottom right stays put.
        const width = clamp(from.width - dx, PANEL_SIZE.minWidth, from.left + from.width);
        const height = clamp(from.height - dy, PANEL_SIZE.minHeight, Math.min(maxHeight(), from.top + from.height));
        box.left = from.left + from.width - width;
        box.top = from.top + from.height - height;
        box.width = width;
        box.height = height;
      }
      place();
    };
    const onUp = (): void => {
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('mouseup', onUp, true);
    };
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('mouseup', onUp, true);
  }

  /**
   * The panel's only key listener, and it is on the panel. Esc closes it;
   * Tab is left to move focus between the panel's own buttons, which it can
   * only do once the panel has focus. A key pressed on the page never
   * reaches here, so the page's Tab is never taken.
   */
  const onKeydown = (e: KeyboardEvent): void => {
    keys++;
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  head.addEventListener('mousedown', (e) => {
    if (e.target === copy || e.target === shut) return;
    startDrag(e, 'move');
  });
  grip.addEventListener('mousedown', (e) => startDrag(e, 'resize'));
  host.addEventListener('keydown', onKeydown);
  // Clicking anywhere in the panel gives it the focus Esc and Tab need.
  panel.addEventListener('mousedown', () => host.focus());
  let copied: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener('click', () => {
    opts.onCopy?.(json);
    copy.textContent = 'copied';
    clearTimeout(copied);
    copied = setTimeout(() => (copy.textContent = 'copy request'), 1200);
  });
  shut.addEventListener('click', () => close());
  const onResize = (): void => {
    if (open) place();
  };
  win.addEventListener('resize', onResize, { passive: true });

  function show(): void {
    if (open) return;
    if (!host.isConnected) doc.documentElement.append(host);
    unregister ??= registerSurface(host);
    open = true;
    host.style.display = 'block';
    corner();
  }

  function close(): void {
    if (!open) return;
    open = false;
    host.style.display = 'none';
    opts.onClose?.();
  }

  function render(view: DebugView): void {
    if (!open) return;
    where.textContent = view.head;
    json = view.request?.json ?? '';
    copy.disabled = view.request === null;
    body.replaceChildren(
      section('Request', requestBlocks(doc, view)),
      section('Answer', answerBlocks(doc, view)),
      section('Timeline', timelineBlocks(doc, view)),
      section('Gate', [rows(doc, view.gate.map((g) => [g.name, g.value] as [string, string]), view.gate)]),
    );
  }

  function section(name: string, children: Element[]): HTMLElement {
    const node = doc.createElement('section');
    node.append(el(doc, 'h2', '', name), ...children);
    return node;
  }

  return {
    open: show,
    close,
    toggle() {
      if (open) close();
      else show();
      return open;
    },
    render,
    destroy() {
      unregister?.();
      unregister = null;
      win.removeEventListener('resize', onResize);
      host.remove();
      open = false;
    },
    get visible() {
      return open;
    },
    get text() {
      return panel.textContent ?? '';
    },
    get keys() {
      return keys;
    },
  };
}

function requestBlocks(doc: Document, view: DebugView): Element[] {
  const request = view.request;
  if (!request) return [el(doc, 'p', 'empty', 'no request from this tab yet')];
  return [rows(doc, request.rows), outline(doc, request.blocks)];
}

function answerBlocks(doc: Document, view: DebugView): Element[] {
  const answer = view.answer;
  if (!answer) return [el(doc, 'p', 'empty', 'no answer on this tab yet')];
  const out: Element[] = [rows(doc, answer.rows)];
  if (answer.raw) out.push(pre(doc, 'raw', answer.raw));
  return out;
}

function timelineBlocks(doc: Document, view: DebugView): Element[] {
  if (view.timeline.length === 0) return [el(doc, 'p', 'empty', 'nothing has happened on this tab yet')];
  const log = doc.createElement('div');
  log.className = 'log';
  for (const row of view.timeline) {
    const line = doc.createElement('div');
    line.className = 'line';
    line.append(el(doc, 'span', 'at', row.when), el(doc, 'span', 'src', row.source), el(doc, 'span', 'what', row.text));
    log.append(line);
  }
  return [log];
}

function rows(doc: Document, pairs: Array<[string, string]>, flags?: GateRow[]): Element {
  const grid = doc.createElement('div');
  grid.className = 'rows';
  pairs.forEach(([k, v], i) => {
    const value = el(doc, 'span', flags && flags[i]?.ok === false ? 'v is-bad' : 'v', v);
    grid.append(el(doc, 'span', 'k', k), value);
  });
  return grid;
}

function pre(doc: Document, name: string, text: string): Element {
  const wrap = doc.createElement('div');
  const block = doc.createElement('pre');
  block.textContent = text;
  block.setAttribute('aria-label', name);
  wrap.append(el(doc, 'span', 'k', name), block);
  return wrap;
}

/**
 * The user turn as it was sent — the page outline, the open tabs, the notes
 * and the history — with the numbered controls picked out, since `[7]` is the
 * only thing in it the model can name. Built as nodes rather than markup:
 * nothing from the page is ever parsed as HTML here.
 */
function outline(doc: Document, text: string): Element {
  const wrap = doc.createElement('div');
  const block = doc.createElement('pre');
  block.setAttribute('aria-label', 'user turn');
  const pattern = /\[\d+\]/g;
  let last = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > last) block.append(doc.createTextNode(text.slice(last, m.index)));
    const mark = doc.createElement('mark');
    mark.textContent = m[0];
    block.append(mark);
    last = m.index + m[0].length;
  }
  block.append(doc.createTextNode(text.slice(last)));
  wrap.append(el(doc, 'span', 'k', 'user turn'), block);
  return wrap;
}

function el(doc: Document, tag: string, className: string, text: string): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
