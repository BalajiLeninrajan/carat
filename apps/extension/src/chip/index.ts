import { fromSurface } from '../dom/surfaces';
import { SCROLL_SETTLE_MS, caratScrolling } from '../scroll';
import { createEffects } from './effects';
import { deepActiveElement, shouldInterceptTab } from './keys';
import { placeChip } from './position';
import { PREVIEW_CSS, PREVIEW_DELAY_MS } from './preview';
import { createSounds } from './sound';
import { CHIP_CSS, TIMING } from './styles';

/**
 * Why the chip went away. `escape` and `typed` are the user saying no to the
 * offer and are reported as such; `acted` and `scrolled` are the user getting
 * on with the page, which says nothing about it. `snoozed` is Shift+Tab: it
 * says nothing about this offer either, it asks for a minute without any.
 */
export type DismissReason = 'escape' | 'timeout' | 'typed' | 'detached' | 'acted' | 'scrolled' | 'snoozed';

/**
 * What the chip is offering. The chip does nothing with it but choose how to
 * leave and what mark to put on the control, so it is its own list rather
 * than an import of the model's schema.
 */
export type ChipKind = 'fill' | 'click' | 'select' | 'scroll' | 'open' | 'switch' | 'none';

/** How the chip goes when the offer is taken, or taken back. */
type Exit = 'collapse' | 'sweep' | 'shrink' | 'soft';

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
  /**
   * One line saying what accepting would actually do, shown only while the
   * pointer or the focus rests on the chip: see `previewLine`.
   */
  preview?: string;
  /** Why it was offered; shown as the native tooltip on hover. */
  reason?: string;
  /** The model may still replace this action; the chip carries a pulsing dot until `settle()`. */
  pending?: boolean;
  /** Sending, paying, deleting: the first Tab arms the chip, the second acts. */
  irreversible?: boolean;
  /** What will happen on Tab, which is what decides how the chip leaves. */
  kind?: ChipKind;
  /**
   * This offer follows one the user already refused. It arrives on the same
   * spring as any other, but without the glow ring: a second try should be
   * quieter than a first offer, not louder.
   */
  retry?: boolean;
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
  /**
   * The line left behind once the chip has accepted and gone: one detail, no
   * label and no key, for `ms` and then nothing. The next chip takes the space
   * back the moment it goes up.
   */
  flash(detail: string, ms: number): void;
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
  /** The hover preview while it is up; the shadow root is closed, so tests read it here. */
  readonly preview: string;
  /** Whether the indicator is up; the shadow root is closed, so tests read it here. */
  readonly pending: boolean;
  /** Whether the first Tab of an irreversible action has landed. */
  readonly armed: boolean;
  /** The options page's "Sound on Tab". Off means no AudioContext is ever built. */
  setSound(on: boolean): void;
  /** What the pill is wearing; the shadow root is closed, so tests read it here. */
  readonly classes: readonly string[];
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
/** A chip nobody has answered by now gets one pulse, and then lets it be. */
export const ATTENTION_AFTER_MS = TIMING.attentionAfterMs;
/** How long each exit runs before the pill is taken off screen. */
const EXIT_MS: Record<Exit, number> = {
  collapse: TIMING.collapseMs,
  sweep: TIMING.sweepMs,
  shrink: TIMING.shrinkMs,
  soft: TIMING.dismissMs,
};
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
  kind: ChipKind | null;
  /** A second try after a refusal: same entrance, no glow. */
  retry: boolean;
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
  const peek = doc.createElement('span');
  peek.className = 'preview';
  peek.hidden = true;
  text.append(label, sub, peek);
  const spinner = doc.createElement('span');
  spinner.className = 'pending';
  spinner.hidden = true;
  const key = doc.createElement('kbd');
  key.textContent = 'Tab';
  pill.append(text, spinner, key);
  const previewStyle = doc.createElement('style');
  previewStyle.textContent = PREVIEW_CSS;
  root.append(style, previewStyle, pill);

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
  /** The accept flash's own clock, which outlives the chip it followed. */
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  // The reason on its own, so the waiting line can go on and come off it.
  let reason = '';
  // The preview line this chip would show, and the rest it is waiting out.
  let previewText = '';
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const win = doc.defaultView ?? window;
  // Every animation that outlives the call that started it, so a chip that
  // goes mid-spring takes its own frames with it.
  let enterTimer: ReturnType<typeof setTimeout> | undefined;
  let glowTimer: ReturnType<typeof setTimeout> | undefined;
  let attentionTimer: ReturnType<typeof setTimeout> | undefined;
  let keyTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  // The marks on the page's own controls, and the three notes Tab makes.
  const fx = createEffects(doc, reducedMotion);
  const sounds = createSounds(win);

  const onKeydown = (e: KeyboardEvent): void => {
    if (!session) return;
    // A key pressed inside one of carat's own surfaces — the debug panel — is
    // the user working carat, not answering the chip. Esc closes the panel,
    // Tab moves inside it, and neither reaches this.
    if (fromSurface(e)) return;
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
    if (!session || onTheChip(e)) return;
    dismiss('acted');
  };

  /**
   * A wheel, a drag or a scroll: the user is reading on, not answering. Two
   * exceptions, both of them carat's own doing: a scroll it started and has
   * not seen stop, and the first settle window of the chip's life, which is
   * the tail of whatever brought this target into view.
   */
  const onUserScroll = (e: Event): void => {
    if (!session || caratScrolling() || Date.now() - session.shownAt < CHIP_SETTLE_MS) return;
    // Scrolling the debug panel's own log is not reading on down the page.
    if (fromSurface(e)) return;
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

  /** A new chip springs in; a first offer also gets one ring, so the eye finds it. */
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
    // A second try after a refusal arrives on the same spring without the ring.
    if (session?.retry) return;
    const glow = doc.createElement('span');
    glow.className = 'glow';
    pill.appendChild(glow);
    pill.classList.add('has-glow');
    glowTimer = setTimeout(() => {
      glowTimer = undefined;
      glow.remove();
      pill.classList.remove('has-glow');
    }, TIMING.glowMs);
  }

  /** The chip went before its entrance finished: drop the frames rather than let them play out. */
  function cancelEnter(): void {
    if (enterTimer !== undefined) clearTimeout(enterTimer);
    enterTimer = undefined;
    if (glowTimer !== undefined) clearTimeout(glowTimer);
    glowTimer = undefined;
    pill.classList.remove('is-entering', 'has-glow');
    pill.querySelector('.glow')?.remove();
  }

  /** Nobody has answered. One pulse, scheduled once per chip and never again. */
  function attention(): void {
    attentionTimer = undefined;
    if (!session) return;
    if (reducedMotion()) {
      pill.classList.add('is-noticed');
      return;
    }
    pill.classList.add('is-attention');
    attentionTimer = setTimeout(() => {
      attentionTimer = undefined;
      pill.classList.remove('is-attention');
    }, TIMING.attentionMs);
  }

  function cancelAttention(): void {
    if (attentionTimer !== undefined) clearTimeout(attentionTimer);
    attentionTimer = undefined;
    pill.classList.remove('is-attention', 'is-noticed');
  }

  /** The keycap goes down under an accepted Tab, and back up on its own. */
  function press(): void {
    cancelKey();
    key.classList.add('is-press');
    keyTimer = setTimeout(cancelKey, TIMING.pressMs);
  }

  /** The value on the chip just changed under the user: the keycap says so. */
  function bump(): void {
    if (reducedMotion()) return;
    cancelKey();
    key.classList.add('is-bump');
    keyTimer = setTimeout(cancelKey, TIMING.bumpMs);
  }

  function cancelKey(): void {
    if (keyTimer !== undefined) clearTimeout(keyTimer);
    keyTimer = undefined;
    key.classList.remove('is-press', 'is-bump');
  }

  /** The model replaced what the placeholder offered: the words cross-fade, the keycap nods. */
  function freshen(): void {
    label.classList.remove('is-fresh');
    // Reading the box restarts the animation when two answers land in a row.
    void pill.offsetWidth;
    label.classList.add('is-fresh');
    bump();
  }

  /** Where a collapse falls: toward the control, when the pill knows where that is. */
  function aimAt(target: Element | null): void {
    pill.style.removeProperty('--carat-origin');
    if (!target) return;
    const p = pill.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (p.width <= 0 || p.height <= 0) return;
    const pct = (v: number): string => `${Math.round(Math.min(100, Math.max(0, v)) * 100)}%`;
    pill.style.setProperty(
      '--carat-origin',
      `${pct((t.left + t.width / 2 - p.left) / p.width)} ${pct((t.top + t.height / 2 - p.top) / p.height)}`,
    );
  }

  /** A scroll sweeps up with the page; a tab shrinks toward the tab strip; everything else collapses. */
  function exitOf(kind: ChipKind | null): Exit {
    if (kind === 'scroll') return 'sweep';
    if (kind === 'open' || kind === 'switch') return 'shrink';
    return 'collapse';
  }

  /** The pill's last frames. It answers nothing by now: the session is already gone. */
  function leave(exit: Exit): void {
    host.style.display = 'block';
    pill.classList.add('is-leaving', `exit-${exit}`);
    exitTimer = setTimeout(endExit, EXIT_MS[exit]);
  }

  /** The last frame is over, or something else wants the pill: take it off screen now. */
  function endExit(): void {
    if (exitTimer !== undefined) clearTimeout(exitTimer);
    exitTimer = undefined;
    pill.classList.remove('is-leaving', 'exit-collapse', 'exit-sweep', 'exit-shrink', 'exit-soft', 'is-armed');
    host.style.display = 'none';
  }

  function setPending(next: boolean): void {
    pending = next;
    spinner.hidden = !next;
    spinner.classList.toggle('is-static', next && reducedMotion());
    const title = next ? (reason ? `${reason} · ${PENDING_HINT}` : PENDING_HINT) : reason;
    if (title) pill.setAttribute('title', title);
    else pill.removeAttribute('title');
  }

  function render(): void {
    const s = session;
    if (!s) return;
    label.textContent = armed ? `Press Tab again to ${lower(s.label)}` : s.label;
    pill.classList.toggle('is-armed', armed);
    // The one loop besides the waiting dot: amber, breathing, until the second Tab.
    pill.classList.toggle('is-breathing', armed && !reducedMotion());
  }

  function mount(opts: ChipText): SessionBase {
    const keepRing = ringTarget;
    hide();
    ringTarget = keepRing;
    sub.textContent = opts.detail ?? '';
    sub.hidden = !opts.detail;
    previewText = opts.preview ?? '';
    reason = opts.reason ?? '';
    setPending(opts.pending === true);
    key.textContent = 'Tab';
    label.classList.remove('is-fresh');
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
    attentionTimer = setTimeout(attention, TIMING.attentionAfterMs);
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
      retry: opts.retry === true,
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
    if (swap) {
      if (replaced) freshen();
      return;
    }
    enter();
    // And a hairline round the control, so the chip and its target read as one thing.
    fx.outline(opts.target);
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
   * The accept flash. It only ever runs with no session up, which is where an
   * accepted chip leaves things: the pill comes back as the banner, carrying
   * the detail line alone, and takes no keys while it is there.
   */
  function flash(detail: string, ms: number): void {
    if (session) return;
    // The accepted chip may still be playing its last frames. They are over:
    // the flash takes the same pill, and the exit's timer would hide it.
    endExit();
    clearTimeout(flashTimer);
    label.textContent = '';
    sub.textContent = detail;
    sub.hidden = false;
    spinner.hidden = true;
    key.hidden = true;
    pill.classList.add('is-banner', 'is-flash');
    host.style.top = 'auto';
    host.style.right = 'auto';
    host.style.left = '50%';
    host.style.bottom = `${CORNER_INSET_PX}px`;
    host.style.transform = 'translateX(-50%)';
    host.style.display = 'block';
    flashTimer = setTimeout(endFlash, ms);
  }

  function endFlash(): void {
    clearTimeout(flashTimer);
    flashTimer = undefined;
    if (!pill.classList.contains('is-flash')) return;
    pill.classList.remove('is-flash');
    key.hidden = false;
    sub.hidden = true;
    sub.textContent = '';
    if (!session) host.style.display = 'none';
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

  /**
   * The chip goes. `exit` is the one case where its last frames outlive it:
   * the session, the listeners and every mark on the page are gone on the
   * spot, so the user acting is answered instantly either way, and what is
   * left on screen is a pill that can no longer do anything.
   */
  function hide(exit?: Exit): void {
    // A chip going up, or anything putting one away, takes the flash with it.
    endFlash();
    const seen = session !== null && host.style.display !== 'none';
    const wasArmed = armed;
    endExit();
    clearRing();
    cancelEnter();
    cancelAttention();
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
    pill.classList.remove('is-still', 'is-breathing');
    if (exit && seen && !reducedMotion()) {
      // An armed chip acts in amber, so the warning's colour stays on for the
      // exit. The breathing does not: it animates the same pill the exit does.
      if (wasArmed) pill.classList.add('is-armed');
      leave(exit);
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
    positionRing();
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
    // An armed chip acts in amber: the same animation, the warning's colour.
    const amber = armed;
    const control = s.target;
    aimAt(s.mode === 'control' ? s.target : null);
    hide(exitOf(s.kind));
    // The keycap and the sound belong to the press, so they come after the
    // teardown: the pill is still on screen for the length of its exit.
    press();
    sounds.accept();
    // And the control keeps the receipt for a moment after the chip has gone.
    if (control?.isConnected) {
      fx.flash(control, { tint: s.kind === 'fill', amber });
      if (s.kind === 'click' || s.kind === 'select') fx.ripple(control, { amber });
    }
    s.onAccept();
  }

  function dismiss(why: DismissReason): void {
    const s = session;
    if (!s) return;
    // Esc and typing over the value are the user answering the offer, so the
    // chip has a moment to fade and drop out of the way. Everything else is
    // the user getting on with the page, and that clears the chip on the frame.
    const soft = why === 'escape' || why === 'typed';
    hide(soft ? 'soft' : undefined);
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
    endFlash();
    hide();
    endExit();
    fx.destroy();
    sounds.close();
    host.remove();
    ringHost.remove();
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
    flash,
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
    get preview() {
      return peek.hidden ? '' : (peek.textContent ?? '');
    },
    get pending() {
      return pending;
    },
    get armed() {
      return armed;
    },
    get classes() {
      return [...pill.classList];
    },
    setSound(on) {
      sounds.setEnabled(on);
    },
  };
}

/** `Click "Save"` reads as `Press Tab again to click "Save"`. */
function lower(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
