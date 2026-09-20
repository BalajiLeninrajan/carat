import { fromSurface } from '../dom/surfaces';
import { Ring } from '../engine/content/ring';
import { createEffects } from './effects';
import { placeChip } from './position';
import { PREVIEW_CSS, PREVIEW_DELAY_MS } from './preview';
import { createSounds } from './sound';
import { ACCEPT_GLYPH, ACCEPT_KEY_NAME, watchTap } from './accept-key';
import { CHIP_CSS, TIMING } from './styles';

/**
 * Why the chip went away. `escape` and `typed` are the user saying no to the
 * offer and are reported as such; `acted` is the user getting on with the
 * page, which says nothing about it. `snoozed` is Shift+Tab, a chord and so
 * never a tap: it says nothing about this offer either, it asks for a minute
 * without any. Scrolling is not on the list. A control carried off the edge
 * of the screen has not been answered, so the offer waits there for it to
 * come back rather than being thrown away.
 */
export type DismissReason = 'escape' | 'timeout' | 'typed' | 'detached' | 'acted' | 'snoozed';

/**
 * What the chip is offering. The chip does nothing with it but choose how to
 * leave and what mark to put on the control, so it is its own list rather
 * than an import of the model's schema.
 */
export type ChipKind = 'fill' | 'click' | 'select' | 'scroll' | 'open' | 'switch' | 'none';

/** One key accepts everything; an irreversible action simply wants it twice. */
export type AcceptKey = 'RightShift';

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
  /**
   * One line saying what accepting would actually do, shown only while the
   * pointer or the focus rests on the chip: see `previewLine`.
   */
  preview?: string;
  /** Why it was offered; shown as the native tooltip on hover. */
  reason?: string;
  /** The model may still replace this action; the chip carries a static dot until `settle()`. */
  pending?: boolean;
  /** Sending, paying, deleting: the first Tab arms the chip, the second acts. */
  irreversible?: boolean;
  /** What will happen on Tab: the mark the control gets when the offer is taken. */
  kind?: ChipKind;
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
  /**
   * Ring a control while the rest of the action is still being written. The
   * ring stays on it for as long as the offer does; it is the same ring the
   * engine puts up the moment a target streams in, not a second one.
   */
  ring(target: Element): void;
  /**
   * The line left behind once the chip has accepted and gone: one detail, no
   * label and no key, for `ms` and then nothing. The next chip takes the space
   * back the moment it goes up.
   */
  /** The action on screen is final: drop the indicator and the tooltip's waiting line, keep the chip. */
  settle(): void;
  hide(): void;
  destroy(): void;
  /** A key pressed inside a frame this chip cannot hear: the tap accepts (or arms), Escape and typing dismiss. */
  relay(key: RelayedKey): void;
  readonly visible: boolean;
  /** The words on the chip; the shadow root is closed, so tests read it here. */
  readonly text: string;
  /** The second line, when there is one; the shadow root is closed, so tests read it here. */
  readonly detail: string;
  /** The hover preview while it is up; the shadow root is closed, so tests read it here. */
  readonly preview: string;
  /** Whether the indicator is up; the shadow root is closed, so tests read it here. */
  readonly pending: boolean;
  /** Whether the first tap of an irreversible action has landed. */
  readonly armed: boolean;
  /** The keycap's glyph and the key it names; the shadow root is closed, so tests read it here. */
  readonly keycap: { readonly glyph: string; readonly name: string | null };
  /** The options page's "Sound on accept". Off means no AudioContext is ever built. */
  setSound(on: boolean): void;
  /** What the pill is wearing; the shadow root is closed, so tests read it here. */
  readonly classes: readonly string[];
}

export const AUTO_DISMISS_MS = 20_000;
export const CORNER_INSET_PX = 24;
/** How long an armed chip waits for the second tap before it stands down. */
export const ARM_MS = 4000;
/** Appended to the chip's reason while a better answer may still land. */
export const PENDING_HINT = 'checking with the model…';
/** The second line a chip carries once the user has said no often enough to want the key. */
export const QUIET_HINT = 'Shift+Tab: quiet for a minute';
/** Held down on their own these say nothing; the key that follows does. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'OS', 'Dead', 'Unidentified']);
const HOST_ATTR = 'data-carat-chip';

interface SessionBase extends ChipCallbacks {
  timer: ReturnType<typeof setTimeout>;
  /** When the chip went up, so a scroll right after it can be read as carat's own. */
  shownAt: number;
  onScreen: boolean;
  /** The control the chip is about, when it has one; keys typed there dismiss as `typed`. */
  target: Element | null;
  interceptFrom: Element | null;
  irreversible: boolean;
  label: string;
  kind: ChipKind | null;
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

/**
 * `rings` is the engine's ring. The caller passes the one it already put up
 * when the target streamed in, so the mark on the control never blinks
 * between "carat is working on this" and "here is the offer".
 */
export function createChip(doc: Document = document, rings: Ring = new Ring()): Chip {
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
  const peek = doc.createElement('span');
  peek.className = 'preview';
  peek.hidden = true;
  text.append(label, sub, peek);
  const key = doc.createElement('kbd');
  key.textContent = ACCEPT_GLYPH;
  key.setAttribute('aria-label', ACCEPT_KEY_NAME);
  pill.append(text, key);
  const previewStyle = doc.createElement('style');
  previewStyle.textContent = PREVIEW_CSS;
  root.append(style, previewStyle, pill);

  let session: Session | null = null;
  let pending = false;
  let armed = false;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  // The reason on its own, so the waiting line can go on and come off it.
  let reason = '';
  // The preview line this chip would show, and the rest it is waiting out.
  let previewText = '';
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const win = doc.defaultView ?? window;
  // Every animation that outlives the call that started it, so a chip that
  // goes mid-spring takes its own frames with it.
  let enterTimer: ReturnType<typeof setTimeout> | undefined;
  let keyTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  // The frame loop that keeps the pill on its control, and the last box it saw.
  let frame: number | undefined;
  let lastBox = '';
  // The marks on the page's own controls, and the three notes Tab makes.
  const fx = createEffects(doc, reducedMotion);
  const sounds = createSounds(win);

  /** The latch behind carat's key: a right Shift pressed and let go on its own. */
  const tap = watchTap();

  const onKeydown = (e: KeyboardEvent): void => {
    if (!session) return;
    // A key pressed inside one of carat's own surfaces — the debug panel — is
    // the user working carat, not answering the chip. Esc closes the panel,
    // Tab moves inside it, and neither reaches this.
    if (fromSurface(e)) {
      tap.cancel();
      return;
    }
    // A chip the user cannot see must not eat their keys; neither should one
    // they can see while an IME is still composing.
    if (!session.onScreen || e.isComposing) {
      tap.cancel();
      return;
    }
    // Carat's key is decided on the way up, and every other key says this
    // hold is a chord rather than a tap.
    if (tap.keydown(e)) return;
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
    // Any other key means the user moved on: an armed chip stands down rather
    // than acting on the next tap.
    if (armed) disarm();
    if (actedOn(e)) dismiss('acted');
  };

  /**
   * The tap lands here. The page never sees the keyup, so a page that watches
   * Shift for itself does not act on carat's key; it did see the keydown,
   * which on its own does nothing anywhere.
   */
  const onKeyup = (e: KeyboardEvent): void => {
    if (!session) return;
    if (!tap.keyup(e)) return;
    if (!session.onScreen || fromSurface(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    accept();
  };

  /**
   * Whether a key press means the user has moved on. A modifier held on its
   * own does not, nor does typing into the field the chip is about, which the
   * `input` listener reports as `typed` instead. Tab does: it is the page's
   * key again, and the focus it moves is the user's own next step.
   */
  function actedOn(e: KeyboardEvent): boolean {
    if (MODIFIER_KEYS.has(e.key)) return false;
    return !aboutTheChipsField(e.target);
  }

  /** The field the chip is about, or the one carat just filled: keys there belong to the `typed` path. */
  function aboutTheChipsField(node: EventTarget | null): boolean {
    if (!session || !(node instanceof Node)) return false;
    const { target, interceptFrom } = session;
    if (target && (target === node || target.contains(node))) return true;
    return !!interceptFrom && (interceptFrom === node || interceptFrom.contains(node));
  }

  /**
   * The chip lives in a closed root, so its host is as deep as a path from
   * outside goes. Carat's other surfaces count the same way: a click in the
   * debug panel is not the user getting on with the page.
   */
  function onTheChip(e: Event): boolean {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(host)) return true;
    if (fromSurface(e)) return true;
    return e.target instanceof Node && host.contains(e.target);
  }

  /** A press, a tap or a click anywhere but the chip itself. */
  const onPointerDown = (e: Event): void => {
    // Shift-clicking is not a tap either.
    tap.cancel();
    if (!session || onTheChip(e)) return;
    dismiss('acted');
  };

  /** Focus landing on another control means the user picked their own next step. */
  const onFocusIn = (e: FocusEvent): void => {
    if (!session || !(e.target instanceof Element)) return;
    if (aboutTheChipsField(e.target) || onTheChip(e)) return;
    const el = e.target;
    if (el === doc.body || el === doc.documentElement) return;
    dismiss('acted');
  };

  /**
   * A device that can only be touched never hovers, so it never gets a
   * preview: on a phone the line would need a press, and a press on the chip
   * is an accept.
   */
  function hoverable(): boolean {
    try {
      return win.matchMedia?.('(hover: none) and (pointer: coarse)').matches !== true;
    } catch {
      return true;
    }
  }

  /**
   * The pointer, or the focus, came to rest on the chip. The preview opens a
   * quarter of a second later, inside the pill, so the anchor never moves.
   */
  const onPeekIn = (e: Event): void => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    if (!session || previewText === '' || !hoverable()) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (!session || previewText === '') return;
      peek.textContent = previewText;
      peek.hidden = false;
    }, PREVIEW_DELAY_MS);
  };

  const onPeekOut = (): void => {
    clearTimeout(previewTimer);
    previewTimer = undefined;
    peek.hidden = true;
  };

  const onTyped = (): void => dismiss('typed');
  const onClick = (e: MouseEvent): void => {
    e.preventDefault();
    accept();
  };
  // Keep focus where it is so the fill lands in the target, not the chip.
  const onMousedown = (e: MouseEvent): void => e.preventDefault();

  const reposition = (): void => {
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
    const wasOnScreen = session.onScreen;
    session.onScreen = visible;
    // The countdown is about an offer the user can see. One carried off the
    // edge has not been turned down, so the clock stops until it is back.
    if (visible !== wasOnScreen) countdown(session, visible);
    host.style.visibility = '';
    if (!visible) {
      host.style.display = 'none';
      return;
    }
    host.style.top = `${Math.round(top)}px`;
    host.style.left = `${Math.round(left)}px`;
  };

  /**
   * The pill sticks to its control. Scroll, resize and a ResizeObserver each
   * cover part of that; a layout shift in a container that fires none of them
   * covers the rest. So the box is read once a frame while a chip is up, and
   * written only when it actually moved.
   */
  function track(): void {
    frame = win.requestAnimationFrame(track);
    if (!session || session.mode !== 'control') return;
    const r = session.target.getBoundingClientRect();
    const box = `${r.left},${r.top},${r.width},${r.height}`;
    if (box === lastBox) return;
    lastBox = box;
    reposition();
  }

  /** Run, or stop, the twenty seconds after which an unanswered chip gives up. */
  function countdown(s: Session, running: boolean): void {
    clearTimeout(s.timer);
    if (running) s.timer = setTimeout(() => dismiss('timeout'), AUTO_DISMISS_MS);
  }

  function startTracking(): void {
    if (frame !== undefined || typeof win.requestAnimationFrame !== 'function') return;
    lastBox = '';
    frame = win.requestAnimationFrame(track);
  }

  function stopTracking(): void {
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    frame = undefined;
    lastBox = '';
  }

  /**
   * The user asked for less motion. Nothing keyed off a keyframe is put on the
   * pill then; the static states say the same thing standing still. The CSS
   * guards it too, but this is what the JS branches on and a test can read.
   */
  function reducedMotion(): boolean {
    try {
      return win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    } catch {
      return false;
    }
  }

  /** A new chip fades up, and rises the 2px that says it arrived. */
  function enter(): void {
    if (reducedMotion()) {
      pill.classList.add('is-still');
      return;
    }
    pill.classList.add('is-entering');
    enterTimer = setTimeout(() => {
      enterTimer = undefined;
      pill.classList.remove('is-entering');
    }, TIMING.enterMs);
  }

  /** The chip went before its entrance finished: drop the frames rather than let them play out. */
  function cancelEnter(): void {
    if (enterTimer !== undefined) clearTimeout(enterTimer);
    enterTimer = undefined;
    pill.classList.remove('is-entering');
  }

  /** The keycap goes down under an accepted tap, and back up on its own. */
  function press(): void {
    cancelKey();
    key.classList.add('is-press');
    keyTimer = setTimeout(cancelKey, TIMING.pressMs);
  }

  function cancelKey(): void {
    if (keyTimer !== undefined) clearTimeout(keyTimer);
    keyTimer = undefined;
    key.classList.remove('is-press');
  }

  /** The model replaced what the placeholder offered: the words cross-fade in place. */
  function freshen(): void {
    label.classList.remove('is-fresh');
    // Reading the box restarts the animation when two answers land in a row.
    void pill.offsetWidth;
    label.classList.add('is-fresh');
  }

  /** The pill's last frames. It answers nothing by now: the session is already gone. */
  function leave(): void {
    host.style.display = 'block';
    pill.classList.add('is-leaving');
    exitTimer = setTimeout(endExit, TIMING.exitMs);
  }

  /** The last frame is over, or something else wants the pill: take it off screen now. */
  function endExit(): void {
    if (exitTimer !== undefined) clearTimeout(exitTimer);
    exitTimer = undefined;
    pill.classList.remove('is-leaving', 'is-armed');
    host.style.display = 'none';
  }

  function setPending(next: boolean): void {
    pending = next;
    const title = next ? (reason ? `${reason} · ${PENDING_HINT}` : PENDING_HINT) : reason;
    if (title) pill.setAttribute('title', title);
    else pill.removeAttribute('title');
  }

  function render(): void {
    const s = session;
    if (!s) return;
    label.textContent = armed ? `Press again to ${lower(s.label)}` : s.label;
    // Armed is what the words say, not a colour the pill takes on: the ring
    // round the control turns red and the pill stays the pill.
    pill.classList.toggle('is-armed', armed);
  }

  function mount(opts: ChipText): SessionBase {
    hide();
    sub.textContent = opts.detail ?? '';
    sub.hidden = !opts.detail;
    previewText = opts.preview ?? '';
    reason = opts.reason ?? '';
    setPending(opts.pending === true);
    key.textContent = ACCEPT_GLYPH;
    label.classList.remove('is-fresh');
    if (!host.isConnected) doc.documentElement.appendChild(host);
    // Capture phase so the page's own handlers never see an accepted tap.
    win.addEventListener('keydown', onKeydown, true);
    win.addEventListener('keyup', onKeyup, true);
    // The user acting on the page for themselves takes the chip with them, whatever shape it is.
    win.addEventListener('pointerdown', onPointerDown, true);
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
      kind: opts.kind ?? null,
      targetWin: null,
      shownAt: Date.now(),
      timer: setTimeout(() => dismiss('timeout'), AUTO_DISMISS_MS),
    };
  }

  function show(opts: ChipShowOptions): void {
    // Re-showing on the same control is a swap: the words change, the chip does not move.
    const swap = session?.mode === 'control' && session.target === opts.target && session.onScreen;
    // The model replacing what the placeholder offered is the only time the
    // words change under the user; that is what the cross-fade is for.
    const replaced = swap && session?.label !== opts.label;
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
    // Capture, so a scroll in any container on the page reaches this and not
    // only a scroll of the window itself.
    win.addEventListener('scroll', reposition, { capture: true, passive: true });
    win.addEventListener('resize', reposition, { passive: true });
    startTracking();
    // A target in a same-origin child frame: its keys and scrolls stay in that window.
    session.targetWin?.addEventListener('keydown', onKeydown, true);
    session.targetWin?.addEventListener('keyup', onKeyup, true);
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
    if (swap) {
      if (replaced) freshen();
      return;
    }
    enter();
  }

  function showBanner(opts: BannerShowOptions): void {
    const previous = session;
    const swap = previous?.mode === 'banner';
    const replaced = swap && previous?.label !== opts.label;
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
    if (swap) {
      if (replaced) freshen();
      return;
    }
    // The banner has no control to sit beside, so it rises into place instead.
    enter();
  }

  /**
   * Put the ring on a control. Before the offer has landed it is the engine's
   * dashed ring; once the chip is up it goes solid and stays until the chip
   * does. Either way it follows the control's box frame by frame, so the ring
   * and the pill move together.
   */
  function ring(target: Element): void {
    rings.show(target);
    if (session) rings.solid();
    rings.setArmed(armed);
  }

  function clearRing(): void {
    rings.hide();
  }

  /**
   * The chip goes. `fade` is the one case where its last frames outlive it:
   * the session, the listeners and every mark on the page are gone on the
   * spot, so the user acting is answered instantly either way, and what is
   * left on screen is a pill that can no longer do anything.
   */
  function hide(fade = false): void {
    const seen = session !== null && host.style.display !== 'none';
    endExit();
    clearRing();
    cancelEnter();
    cancelKey();
    fx.clear();
    onPeekOut();
    previewText = '';
    if (!session) return;
    const s = session;
    session = null;
    clearTimeout(s.timer);
    clearTimeout(armTimer);
    armed = false;
    win.removeEventListener('keydown', onKeydown, true);
    win.removeEventListener('keyup', onKeyup, true);
    win.removeEventListener('pointerdown', onPointerDown, true);
    win.removeEventListener('focusin', onFocusIn, true);
    pill.removeEventListener('click', onClick);
    pill.removeEventListener('mousedown', onMousedown);
    stopTracking();
    if (s.mode === 'control') {
      s.observer?.disconnect();
      win.removeEventListener('scroll', reposition, true);
      win.removeEventListener('resize', reposition);
      s.targetWin?.removeEventListener('keydown', onKeydown, true);
      s.targetWin?.removeEventListener('keyup', onKeyup, true);
      s.targetWin?.removeEventListener('scroll', reposition, true);
      s.target.removeEventListener('input', onTyped);
      s.interceptFrom?.removeEventListener('input', onTyped);
    } else {
      doc.removeEventListener('input', onTyped, true);
    }
    setPending(false);
    pill.classList.remove('is-still');
    if (fade && seen && !reducedMotion()) {
      leave();
      return;
    }
    pill.classList.remove('is-armed');
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
    rings.setArmed(true);
    sounds.arm();
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
    rings.setArmed(false);
  }

  function accept(): void {
    const s = session;
    if (!s) return;
    // Anything that cannot be undone takes a second tap, and says so in between.
    if (s.irreversible && !armed) {
      arm();
      return;
    }
    // An irreversible action leaves its receipt in the ring's red.
    const alarm = armed;
    const control = s.target;
    hide(true);
    // The keycap and the sound belong to the press, so they come after the
    // teardown: the pill is still on screen for the length of its exit.
    press();
    sounds.accept();
    // And the control keeps the receipt for a moment after the chip has gone.
    if (control?.isConnected) fx.flash(control, { alarm });
    s.onAccept();
  }

  function dismiss(why: DismissReason): void {
    const s = session;
    if (!s) return;
    // Esc and typing over the value are the user answering the offer, so the
    // chip has a moment to fade and drop out of the way. Everything else is
    // the user getting on with the page, and that clears the chip on the frame.
    const soft = why === 'escape' || why === 'typed';
    hide(soft);
    // Only Esc gets a note: typing over the value is already making its own noise.
    if (why === 'escape') sounds.dismiss();
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
    endExit();
    fx.destroy();
    sounds.close();
    host.remove();
    rings.element?.remove();
  }

  // Bound once, for the life of the chip, and on the host rather than the
  // pill: `pointerenter` does not bubble, and the root is closed. The pill is
  // focusable but out of the page's tab order, so Tab still belongs to the offer.
  pill.tabIndex = -1;
  host.addEventListener('pointerenter', onPeekIn);
  host.addEventListener('pointerleave', onPeekOut);
  host.addEventListener('focusin', onPeekIn);
  host.addEventListener('focusout', onPeekOut);

  return {
    show,
    showBanner,
    ring,
    settle,
    hide: () => hide(),
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
    get preview() {
      return peek.hidden ? '' : (peek.textContent ?? '');
    },
    get pending() {
      return pending;
    },
    get armed() {
      return armed;
    },
    get keycap() {
      return { glyph: key.textContent ?? '', name: key.getAttribute('aria-label') };
    },
    get classes() {
      return [...pill.classList];
    },
    setSound(on) {
      sounds.setEnabled(on);
    },
  };
}

/** `Click "Save"` reads as `Press again to click "Save"`. */
function lower(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
