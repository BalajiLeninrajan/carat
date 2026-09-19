import { SCROLL_SETTLE_MS, caratScrolling } from '../scroll';
import { deepActiveElement, shouldInterceptTab } from './keys';
import { placeChip } from './position';
import { CHIP_CSS } from './styles';

/**
 * Why the chip went away. `escape` and `typed` are the user saying no to the
 * offer and are reported as such; `acted` and `scrolled` are the user getting
 * on with the page, which says nothing about it. `snoozed` is Shift+Tab: it
 * says nothing about this offer either, it asks for a minute without any.
 */
export type DismissReason = 'escape' | 'timeout' | 'typed' | 'detached' | 'acted' | 'scrolled' | 'snoozed';

/** Tab accepts everything now; an irreversible action simply wants it twice. */
export type AcceptKey = 'Tab';

/** A key, or a keystroke, heard in a frame the chip cannot listen to itself, relayed by that frame's agent. */
export type RelayedKey = AcceptKey | 'Escape' | 'typed';

interface ChipCallbacks {
  /** Called after the chip has hidden itself; the caller performs the action. */
  onAccept: () => void;
  onDismiss: (reason: DismissReason) => void;
  /** The first Tab on an irreversible action armed the chip; the second will act. */
  onArm?: () => void;
}

interface ChipText extends ChipCallbacks {
  /** What the chip says, in the imperative: `Click "Proceed to checkout"`. */
  label: string;
  /** Second line under the offer: where the value came from, e.g. "from discord.com · 2m ago". */
  detail?: string;
  /** Why it was offered; shown as the native tooltip on hover. */
  reason?: string;
  /** The model may still replace this action; the chip carries a pulsing dot until `settle()`. */
  pending?: boolean;
  /** Sending, paying, deleting: the first Tab arms the chip, the second acts. */
  irreversible?: boolean;
}

export interface ChipShowOptions extends ChipText {
  target: Element;
  /**
   * An element Tab is also taken from, besides the target: the field carat
   * just filled, which still holds focus while the next chip is up.
   */
  interceptFrom?: Element | null;
  /**
   * Where the chip sits when the target's own box is not the answer: a
   * control inside a cross-origin frame, whose box the frame reported. Null
   * means off-screen right now.
   */
  anchor?: () => DOMRect | null;
}

/** A chip with no control of its own: a banner centred at the bottom that takes Tab from anywhere on the page. */
export interface BannerShowOptions extends ChipText {
  /** The element the banner is about, when it has one. With it, Tab is taken by the same rule as a chip. */
  target?: Element;
  interceptFrom?: Element | null;
}

export interface Chip {
  show(opts: ChipShowOptions): void;
  showBanner(opts: BannerShowOptions): void;
  /** Ring a control while the rest of the action is still being written. */
  ring(target: Element): void;
  /** The action on screen is final: drop the indicator and the tooltip's waiting line, keep the chip. */
  settle(): void;
  hide(): void;
  destroy(): void;
  /** A key pressed inside a frame this chip cannot hear: Tab accepts (or arms), Escape and typing dismiss. */
  relay(key: RelayedKey): void;
  readonly visible: boolean;
  /** The words on the chip; the shadow root is closed, so tests read it here. */
  readonly text: string;
  /** The second line, when there is one; the shadow root is closed, so tests read it here. */
  readonly detail: string;
  /** Whether the indicator is up; the shadow root is closed, so tests read it here. */
  readonly pending: boolean;
  /** Whether the first Tab of an irreversible action has landed. */
  readonly armed: boolean;
}

export const AUTO_DISMISS_MS = 20_000;
export const CORNER_INSET_PX = 24;
/** How long an armed chip waits for the second Tab before it stands down. */
export const ARM_MS = 4000;
/** Appended to the chip's reason while a better answer may still land. */
export const PENDING_HINT = 'checking with the model…';
/** The second line a chip carries once the user has said no often enough to want the key. */
export const QUIET_HINT = 'Shift+Tab: quiet for a minute';
/**
 * A chip ignores scrolling for this long after it goes up: that tail belongs
 * to the scroll carat itself did to bring the target into view. Per chip, not
 * a flag shared with the scroller, which would leak between pages.
 */
export const CHIP_SETTLE_MS = SCROLL_SETTLE_MS;
/** Held down on their own these say nothing; the key that follows does. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'OS', 'Dead', 'Unidentified']);
const HOST_ATTR = 'data-carat-chip';
const RING_ATTR = 'data-carat-ring';

interface SessionBase extends ChipCallbacks {
  timer: ReturnType<typeof setTimeout>;
  /** When the chip went up, so a scroll right after it can be read as carat's own. */
  shownAt: number;
  onScreen: boolean;
  /** When set, the key defers to a text field that has focus unless it is this or `interceptFrom`. */
  target: Element | null;
  interceptFrom: Element | null;
  irreversible: boolean;
  label: string;
  /** The window of a same-origin child frame the target lives in; its keys never reach the top window. */
  targetWin: Window | null;
}
interface ControlSession extends SessionBase {
  mode: 'control';
  target: Element;
  observer: ResizeObserver | null;
  anchor: (() => DOMRect | null) | null;
}
interface BannerSession extends SessionBase {
  mode: 'banner';
}
type Session = ControlSession | BannerSession;

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
  const spinner = doc.createElement('span');
  spinner.className = 'pending';
  spinner.hidden = true;
  const key = doc.createElement('kbd');
  key.textContent = 'Tab';
  pill.append(text, spinner, key);
  root.append(style, pill);

  // The ring lives in its own host: it goes up on the target as soon as the
  // model names it, before there is anything to say about it.
  const ringHost = doc.createElement('div');
  ringHost.setAttribute(RING_ATTR, '');
  ringHost.style.cssText = 'all:initial;position:fixed;pointer-events:none;z-index:2147483646;display:none;border-radius:7px;border:2px solid #89b4fa;box-shadow:0 0 0 4px rgba(137,180,250,.18);';
  let ringTarget: Element | null = null;

  let session: Session | null = null;
  let pending = false;
  let armed = false;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  // The reason on its own, so the waiting line can go on and come off it.
  let reason = '';
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
    // Shift+Tab is only carat's while there is something on screen to silence;
    // with no chip up the listener is not even bound, so the page keeps the key.
    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      // An armed chip stands down first: the minute must not start with a live second Tab.
      disarm();
      dismiss('snoozed');
      return;
    }
    const bare = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    // A banner has no control of its own to defer to; Tab is its whole interface.
    const deferred = session.target !== null && !shouldInterceptTab(deepActiveElement(doc), session.target, session.interceptFrom);
    if (e.key === 'Tab' && bare && !deferred) {
      e.preventDefault();
      e.stopImmediatePropagation();
      accept();
      return;
    }
    // Any other key means the user moved on: an armed chip stands down rather than acting on the next Tab.
    if (armed) disarm();
    if (actedOn(e)) dismiss('acted');
  };

  /**
   * Whether a key press means the user has moved on. Tab never does: it is
   * carat's key, and one the chip may have let through on purpose. Nor does a
   * modifier held on its own, nor typing into the field the chip is about,
   * which the `input` listener reports as `typed` instead.
   */
  function actedOn(e: KeyboardEvent): boolean {
    if (e.key === 'Tab' || MODIFIER_KEYS.has(e.key)) return false;
    return !aboutTheChipsField(e.target);
  }

  /** The field the chip is about, or the one carat just filled: keys there belong to the `typed` path. */
  function aboutTheChipsField(node: EventTarget | null): boolean {
    if (!session || !(node instanceof Node)) return false;
    const { target, interceptFrom } = session;
    if (target && (target === node || target.contains(node))) return true;
    return !!interceptFrom && (interceptFrom === node || interceptFrom.contains(node));
  }

  /** The chip lives in a closed root, so its host is as deep as a path from outside goes. */
  function onTheChip(e: Event): boolean {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(host)) return true;
    return e.target instanceof Node && host.contains(e.target);
  }

  /** A press, a tap or a click anywhere but the chip itself. */
  const onPointerDown = (e: Event): void => {
    if (!session || onTheChip(e)) return;
    dismiss('acted');
  };

  /**
   * A wheel, a drag or a scroll: the user is reading on, not answering. Two
   * exceptions, both of them carat's own doing: a scroll it started and has
   * not seen stop, and the first settle window of the chip's life, which is
   * the tail of whatever brought this target into view.
   */
  const onUserScroll = (): void => {
    if (!session || caratScrolling() || Date.now() - session.shownAt < CHIP_SETTLE_MS) return;
    dismiss('scrolled');
  };

  /** Focus landing on another control means the user picked their own next step. */
  const onFocusIn = (e: FocusEvent): void => {
    if (!session || !(e.target instanceof Element)) return;
    if (aboutTheChipsField(e.target) || onTheChip(e)) return;
    const el = e.target;
    if (el === doc.body || el === doc.documentElement) return;
    dismiss('acted');
  };

  const onTyped = (): void => dismiss('typed');
  const onClick = (e: MouseEvent): void => {
    e.preventDefault();
    accept();
  };
  // Keep focus where it is so the fill lands in the target, not the chip.
  const onMousedown = (e: MouseEvent): void => e.preventDefault();

  const reposition = (): void => {
    positionRing();
    if (!session || session.mode !== 'control') return;
    if (!session.target.isConnected) {
      dismiss('detached');
      return;
    }
    const wasHidden = host.style.display === 'none';
    if (wasHidden) host.style.visibility = 'hidden';
    host.style.display = 'block';
    const anchored = session.anchor ? session.anchor() : undefined;
    const { top, left, visible } =
      anchored === null
        ? { top: 0, left: 0, visible: false }
        : placeChip(session.target, pill.offsetWidth, pill.offsetHeight, anchored);
    session.onScreen = visible;
    host.style.visibility = '';
    if (!visible) {
      host.style.display = 'none';
      return;
    }
    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
  };

  /** The dot is static when the user asked for less motion; the CSS says the same, this is what a test can read. */
  function stillDot(): boolean {
    try {
      return win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    } catch {
      return false;
    }
  }

  function setPending(next: boolean): void {
    pending = next;
    spinner.hidden = !next;
    spinner.classList.toggle('is-static', next && stillDot());
    const title = next ? (reason ? `${reason} · ${PENDING_HINT}` : PENDING_HINT) : reason;
    if (title) pill.setAttribute('title', title);
    else pill.removeAttribute('title');
  }

  function render(): void {
    const s = session;
    if (!s) return;
    label.textContent = armed ? `Press Tab again to ${lower(s.label)}` : s.label;
    pill.classList.toggle('is-armed', armed);
  }

  function mount(opts: ChipText): SessionBase {
    const keepRing = ringTarget;
    hide();
    ringTarget = keepRing;
    sub.textContent = opts.detail ?? '';
    sub.hidden = !opts.detail;
    reason = opts.reason ?? '';
    setPending(opts.pending === true);
    key.textContent = 'Tab';
    if (!host.isConnected) doc.documentElement.appendChild(host);
    // Capture phase so the page's own Tab handlers never see an accepted Tab.
    win.addEventListener('keydown', onKeydown, true);
    // The user acting on the page for themselves takes the chip with them, whatever shape it is.
    win.addEventListener('pointerdown', onPointerDown, true);
    win.addEventListener('wheel', onUserScroll, { capture: true, passive: true });
    win.addEventListener('touchmove', onUserScroll, { capture: true, passive: true });
    win.addEventListener('scroll', onUserScroll, { capture: true, passive: true });
    win.addEventListener('focusin', onFocusIn, true);
    pill.addEventListener('click', onClick);
    pill.addEventListener('mousedown', onMousedown);
    return {
      onAccept: opts.onAccept,
      onDismiss: opts.onDismiss,
      ...(opts.onArm ? { onArm: opts.onArm } : {}),
      onScreen: false,
      target: null,
      interceptFrom: null,
      irreversible: opts.irreversible === true,
      label: opts.label,
      targetWin: null,
      shownAt: Date.now(),
      timer: setTimeout(() => dismiss('timeout'), AUTO_DISMISS_MS),
    };
  }

  function show(opts: ChipShowOptions): void {
    // Re-showing on the same control is a swap: the words change, the chip does not move.
    const swap = session?.mode === 'control' && session.target === opts.target && session.onScreen;
    const held = swap ? { top: host.style.top, left: host.style.left } : null;
    const base = mount(opts);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => reposition()) : null;
    observer?.observe(opts.target);
    const targetWin = opts.target.ownerDocument.defaultView;
    session = {
      ...base,
      mode: 'control',
      target: opts.target,
      interceptFrom: opts.interceptFrom ?? null,
      observer,
      anchor: opts.anchor ?? null,
      targetWin: targetWin && targetWin !== win ? targetWin : null,
    };
    pill.classList.remove('is-banner');
    host.style.right = '';
    host.style.bottom = '';
    host.style.transform = '';
    win.addEventListener('scroll', reposition, { capture: true, passive: true });
    win.addEventListener('resize', reposition, { passive: true });
    // A target in a same-origin child frame: its keys and scrolls stay in that window.
    session.targetWin?.addEventListener('keydown', onKeydown, true);
    session.targetWin?.addEventListener('scroll', reposition, { capture: true, passive: true });
    opts.target.addEventListener('input', onTyped);
    // Typing on in the field carat just filled means the user is busy there, not ready for the next chip.
    opts.interceptFrom?.addEventListener('input', onTyped);
    ring(opts.target);
    render();
    reposition();
    // The control's box is nowhere the chip can sit — a field in a frame that
    // is scrolled out of view, an anchor the frame reported as off screen. A
    // chip that is mounted but invisible eats nothing and offers nothing, so
    // the offer moves to the banner, which is always somewhere.
    if (session?.mode === 'control' && !session.onScreen) {
      showBanner({ ...opts, target: opts.target });
      return;
    }
    // A longer label would shift the pill out from under the user's eye; put it back.
    if (held && host.style.display !== 'none') {
      host.style.top = held.top;
      host.style.left = held.left;
    }
  }

  function showBanner(opts: BannerShowOptions): void {
    const base = mount(opts);
    session = { ...base, mode: 'banner', onScreen: true, target: opts.target ?? null, interceptFrom: opts.interceptFrom ?? null };
    pill.classList.add('is-banner');
    host.style.top = 'auto';
    host.style.right = 'auto';
    host.style.left = '50%';
    host.style.bottom = `${CORNER_INSET_PX}px`;
    host.style.transform = 'translateX(-50%)';
    host.style.display = 'block';
    render();
    // Typing anywhere means the user is busy; the offer gets out of the way.
    doc.addEventListener('input', onTyped, true);
  }

  /** Put the ring on a control before there is anything to say about it. */
  function ring(target: Element): void {
    ringTarget = target;
    if (!ringHost.isConnected) doc.documentElement.appendChild(ringHost);
    ringHost.style.display = 'block';
    ringHost.style.borderStyle = session ? 'solid' : 'dashed';
    positionRing();
  }

  function positionRing(): void {
    if (!ringTarget) return;
    if (!ringTarget.isConnected) {
      clearRing();
      return;
    }
    const r = ringTarget.getBoundingClientRect();
    ringHost.style.left = `${Math.round(r.left - 3)}px`;
    ringHost.style.top = `${Math.round(r.top - 3)}px`;
    ringHost.style.width = `${Math.round(r.width + 6)}px`;
    ringHost.style.height = `${Math.round(r.height + 6)}px`;
    ringHost.style.borderColor = armed ? '#f9e2af' : '#89b4fa';
  }

  function clearRing(): void {
    ringTarget = null;
    ringHost.style.display = 'none';
  }

  function hide(): void {
    clearRing();
    if (!session) return;
    const s = session;
    session = null;
    clearTimeout(s.timer);
    clearTimeout(armTimer);
    armed = false;
    win.removeEventListener('keydown', onKeydown, true);
    win.removeEventListener('pointerdown', onPointerDown, true);
    win.removeEventListener('wheel', onUserScroll, true);
    win.removeEventListener('touchmove', onUserScroll, true);
    win.removeEventListener('scroll', onUserScroll, true);
    win.removeEventListener('focusin', onFocusIn, true);
    pill.removeEventListener('click', onClick);
    pill.removeEventListener('mousedown', onMousedown);
    if (s.mode === 'control') {
      s.observer?.disconnect();
      win.removeEventListener('scroll', reposition, true);
      win.removeEventListener('resize', reposition);
      s.targetWin?.removeEventListener('keydown', onKeydown, true);
      s.targetWin?.removeEventListener('scroll', reposition, true);
      s.target.removeEventListener('input', onTyped);
      s.interceptFrom?.removeEventListener('input', onTyped);
    } else {
      doc.removeEventListener('input', onTyped, true);
    }
    setPending(false);
    host.style.display = 'none';
  }

  /** The ticket closed: whatever is on the chip now is the answer. */
  function settle(): void {
    if (pending) setPending(false);
  }

  function arm(): void {
    const s = session;
    if (!s) return;
    armed = true;
    render();
    positionRing();
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      if (session === s) disarm();
    }, ARM_MS);
    s.onArm?.();
  }

  function disarm(): void {
    if (!armed) return;
    armed = false;
    clearTimeout(armTimer);
    render();
    positionRing();
  }

  function accept(): void {
    const s = session;
    if (!s) return;
    // Anything that cannot be undone takes a second Tab, and says so in between.
    if (s.irreversible && !armed) {
      arm();
      return;
    }
    hide();
    s.onAccept();
  }

  function dismiss(why: DismissReason): void {
    const s = session;
    if (!s) return;
    hide();
    s.onDismiss(why);
  }

  function relay(k: RelayedKey): void {
    if (!session || !session.onScreen) return;
    if (k === 'Escape') dismiss('escape');
    else if (k === 'typed') dismiss('typed');
    else accept();
  }

  function destroy(): void {
    hide();
    host.remove();
    ringHost.remove();
  }

  return {
    show,
    showBanner,
    ring,
    settle,
    hide,
    destroy,
    relay,
    get visible() {
      return session !== null;
    },
    get text() {
      return label.textContent ?? '';
    },
    get detail() {
      return sub.hidden ? '' : (sub.textContent ?? '');
    },
    get pending() {
      return pending;
    },
    get armed() {
      return armed;
    },
  };
}

/** `Click "Save"` reads as `Press Tab again to click "Save"`. */
function lower(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
