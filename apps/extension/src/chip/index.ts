import { deepActiveElement, shouldInterceptTab } from './keys';
import { placeChip } from './position';
import { CHIP_CSS } from './styles';

export type DismissReason = 'escape' | 'timeout' | 'typed' | 'detached';

interface ChipCallbacks {
  /** Called after the chip has hidden itself; the caller performs the fill or the navigation. */
  onAccept: () => void;
  onDismiss: (reason: DismissReason) => void;
}

/** What both chip shapes say besides the value. */
interface ChipText extends ChipCallbacks {
  value: string;
  /** Second line under the offer: where the value came from, e.g. "from discord.com · 2m ago". */
  detail?: string;
  /** Why it was offered; shown as the native tooltip on hover. */
  reason?: string;
}

export interface ChipShowOptions extends ChipText {
  target: Element;
  /** The word before the quoted value: "Fill" (default), "Click", "Check", "Set"... */
  verb?: string;
  /** Text after the quoted value and before the question mark: " to 40". */
  tail?: string;
  /**
   * An element Tab is also taken from, besides the target: the field carat
   * just filled, which still holds focus while the next chip is up.
   */
  interceptFrom?: Element | null;
}

/** A chip with no field: a larger banner centred at the bottom of the viewport that takes Tab from anywhere on the page. */
export interface CornerShowOptions extends ChipText {
  label: string; // "Open in Google Maps"
  /** Leave out the colon after the label: `Scroll to "Save"?` rather than `Open in Google Maps: "Seven Shores Cafe"?`. */
  bare?: boolean;
  /**
   * The element the banner is about, when it has one (the off-screen target
   * of a scroll). With it, Tab is taken only when nothing else could want it,
   * by the same rule as a field chip; without it, from anywhere.
   */
  target?: Element;
  interceptFrom?: Element | null;
}

export interface Chip {
  show(opts: ChipShowOptions): void;
  showCorner(opts: CornerShowOptions): void;
  hide(): void;
  destroy(): void;
  readonly visible: boolean;
  /** The words on the chip, e.g. `Click "Save"?`; the shadow root is closed, so tests read it here. */
  readonly text: string;
}

export const AUTO_DISMISS_MS = 20_000;
export const CORNER_INSET_PX = 24;
const VALUE_MAX = 40;
const HOST_ATTR = 'data-carat-chip';

interface SessionBase extends ChipCallbacks {
  timer: ReturnType<typeof setTimeout>;
  onScreen: boolean;
  /** When set, Tab defers to a text field that has focus unless it is this or `interceptFrom`. */
  target: Element | null;
  interceptFrom: Element | null;
}
interface FieldSession extends SessionBase {
  mode: 'field';
  target: Element;
  observer: ResizeObserver | null;
}
interface CornerSession extends SessionBase {
  mode: 'corner';
}
type Session = FieldSession | CornerSession;

export function createChip(doc: Document = document): Chip {
  const host = doc.createElement('div');
  host.setAttribute(HOST_ATTR, '');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;z-index:2147483647;display:none;';
  const root = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = CHIP_CSS;
  const pill = doc.createElement('div');
  pill.className = 'chip';
  pill.setAttribute('role', 'button');
  const text = doc.createElement('span');
  text.className = 'text';
  const label = doc.createElement('span');
  label.className = 'label';
  const sub = doc.createElement('span');
  sub.className = 'sub';
  text.append(label, sub);
  const key = doc.createElement('kbd');
  key.textContent = 'Tab';
  pill.append(text, key);
  root.append(style, pill);

  let session: Session | null = null;
  const win = doc.defaultView ?? window;

  const onKeydown = (e: KeyboardEvent): void => {
    if (!session) return;
    // A chip the user cannot see must not eat their keys; neither should one
    // they can see while an IME is still composing.
    if (!session.onScreen || e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      dismiss('escape');
      return;
    }
    if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    // A tab-offer banner has no field of its own to defer to; Tab is its whole interface.
    if (session.target && !shouldInterceptTab(deepActiveElement(doc), session.target, session.interceptFrom)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    accept();
  };

  const onTyped = (): void => dismiss('typed');
  const onClick = (e: MouseEvent): void => {
    e.preventDefault();
    accept();
  };
  // Keep focus where it is so the fill lands in the target, not the chip.
  const onMousedown = (e: MouseEvent): void => e.preventDefault();

  const reposition = (): void => {
    if (!session || session.mode !== 'field') return;
    if (!session.target.isConnected) {
      dismiss('detached');
      return;
    }
    const wasHidden = host.style.display === 'none';
    if (wasHidden) host.style.visibility = 'hidden';
    host.style.display = 'block';
    const { top, left, visible } = placeChip(session.target, pill.offsetWidth, pill.offsetHeight);
    session.onScreen = visible;
    host.style.visibility = '';
    if (!visible) {
      host.style.display = 'none';
      return;
    }
    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
  };

  function mount(verb: string, tail: string, opts: ChipText): SessionBase {
    hide();
    label.replaceChildren(`${verb} `, valueNode(opts.value), `${tail}?`);
    sub.textContent = opts.detail ?? '';
    sub.hidden = !opts.detail;
    if (opts.reason) pill.setAttribute('title', opts.reason);
    else pill.removeAttribute('title');
    if (!host.isConnected) doc.documentElement.appendChild(host);
    // Capture phase so the page's own Tab handlers never see an accepted Tab.
    win.addEventListener('keydown', onKeydown, true);
    pill.addEventListener('click', onClick);
    pill.addEventListener('mousedown', onMousedown);
    return {
      onAccept: opts.onAccept,
      onDismiss: opts.onDismiss,
      onScreen: false,
      target: null,
      interceptFrom: null,
      timer: setTimeout(() => dismiss('timeout'), AUTO_DISMISS_MS),
    };
  }

  function show(opts: ChipShowOptions): void {
    const base = mount(opts.verb ?? 'Fill', opts.tail ?? '', opts);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => reposition()) : null;
    observer?.observe(opts.target);
    session = { ...base, mode: 'field', target: opts.target, interceptFrom: opts.interceptFrom ?? null, observer };
    pill.classList.remove('is-banner');
    host.style.right = '';
    host.style.bottom = '';
    host.style.transform = '';
    win.addEventListener('scroll', reposition, { capture: true, passive: true });
    win.addEventListener('resize', reposition, { passive: true });
    opts.target.addEventListener('input', onTyped);
    // Typing on in the field carat just filled means the user is busy there, not ready for the next chip.
    opts.interceptFrom?.addEventListener('input', onTyped);
    reposition();
  }

  function showCorner(opts: CornerShowOptions): void {
    const base = mount(opts.bare ? opts.label : `${opts.label}:`, '', opts);
    session = { ...base, mode: 'corner', onScreen: true, target: opts.target ?? null, interceptFrom: opts.interceptFrom ?? null };
    pill.classList.add('is-banner');
    host.style.top = 'auto';
    host.style.right = 'auto';
    host.style.left = '50%';
    host.style.bottom = `${CORNER_INSET_PX}px`;
    host.style.transform = 'translateX(-50%)';
    host.style.display = 'block';
    // Typing anywhere means the user is busy; the offer gets out of the way.
    doc.addEventListener('input', onTyped, true);
  }

  function hide(): void {
    if (!session) return;
    const s = session;
    session = null;
    clearTimeout(s.timer);
    win.removeEventListener('keydown', onKeydown, true);
    pill.removeEventListener('click', onClick);
    pill.removeEventListener('mousedown', onMousedown);
    if (s.mode === 'field') {
      s.observer?.disconnect();
      win.removeEventListener('scroll', reposition, true);
      win.removeEventListener('resize', reposition);
      s.target.removeEventListener('input', onTyped);
      s.interceptFrom?.removeEventListener('input', onTyped);
    } else {
      doc.removeEventListener('input', onTyped, true);
    }
    host.style.display = 'none';
  }

  function accept(): void {
    const s = session;
    if (!s) return;
    hide();
    s.onAccept();
  }

  function dismiss(reason: DismissReason): void {
    const s = session;
    if (!s) return;
    hide();
    s.onDismiss(reason);
  }

  function destroy(): void {
    hide();
    host.remove();
  }

  function valueNode(value: string): HTMLElement {
    const span = doc.createElement('span');
    span.className = 'value';
    const shown = value.length > VALUE_MAX ? `${value.slice(0, VALUE_MAX - 1)}…` : value;
    span.textContent = `"${shown}"`;
    return span;
  }

  return {
    show,
    showCorner,
    hide,
    destroy,
    get visible() {
      return session !== null;
    },
    get text() {
      return label.textContent ?? '';
    },
  };
}
