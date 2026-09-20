import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ARM_MS, AUTO_DISMISS_MS, CORNER_INSET_PX, PENDING_HINT, createChip, type Chip, type DismissReason } from '../src/chip';
import { placeAt } from '../src/chip/position';
import { ACCEPT_KEYS } from '../src/chip/accept-key';
import { CHIP_CSS, FX_CSS, KEYCAP, KEYCAP_CSS, KEYFRAME_CLASSES, LINE_PX, PILL, TIMING, TYPE } from '../src/chip/styles';
import { RING, Ring } from '../src/engine/content/ring';

/** jsdom has no Web Audio; this is enough of a context to count how many were built. */
class FakeAudioContext {
  static built = 0;
  currentTime = 0;
  state = 'running';
  destination = {};
  constructor() {
    FakeAudioContext.built++;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  createOscillator(): unknown {
    return { type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} };
  }
  createGain(): unknown {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
  }
}

/** Every query answers the same way, so the chip's one query is the one that matters. */
function askedForLessMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: reduce && media.includes('prefers-reduced-motion'),
    addEventListener() {},
    removeEventListener() {},
  }));
}

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

/** Caret's key: the right Shift pressed and let go with nothing in between. */
function tap(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const shape = { key: 'Shift', code: ACCEPT_KEYS.rightShift.code, location: 2, shiftKey: true, bubbles: true, cancelable: true, ...init };
  target.dispatchEvent(new KeyboardEvent('keydown', shape));
  const up = new KeyboardEvent('keyup', { ...shape, shiftKey: false });
  target.dispatchEvent(up);
  return up;
}

/** The right Shift held down while another key is pressed: a chord, not a tap. */
function chord(target: EventTarget, k: string): KeyboardEvent {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: ACCEPT_KEYS.rightShift.code, location: 2, shiftKey: true, bubbles: true, cancelable: true }));
  const inner = new KeyboardEvent('keydown', { key: k, shiftKey: true, bubbles: true, cancelable: true });
  target.dispatchEvent(inner);
  target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: ACCEPT_KEYS.rightShift.code, location: 2, bubbles: true, cancelable: true }));
  return inner;
}

function hosts(): NodeListOf<Element> {
  return document.querySelectorAll('[data-caret-chip]');
}

function ringHosts(): NodeListOf<Element> {
  return document.querySelectorAll('caret-ring');
}

// jsdom reports zero-size rects; give the target a viewport position.
function onScreen(el: Element, top = 100, left = 20): void {
  el.getBoundingClientRect = () =>
    ({ top, left, bottom: top + 30, right: left + 200, width: 200, height: 30 }) as DOMRect;
}

/** The same control, scrolled off the top of the page. */
function offScreen(el: Element): void {
  onScreen(el, -400);
}

/** One animation frame, which is how often the pill re-reads its control's box. */
const FRAME_MS = 20;

describe('chip', () => {
  let chip: Chip;
  let ring: Ring;
  let target: HTMLInputElement;
  let other: HTMLInputElement;
  let onAccept: Mock<() => void>;
  let onDismiss: Mock<(reason: DismissReason) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    target = document.createElement('input');
    other = document.createElement('input');
    onScreen(target);
    document.body.append(target, other);
    ring = new Ring();
    chip = createChip(document, ring);
    onAccept = vi.fn<() => void>();
    onDismiss = vi.fn<(reason: DismissReason) => void>();
  });

  afterEach(() => {
    chip.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const show = (over: Partial<Parameters<Chip['show']>[0]> = {}): void =>
    chip.show({ target, label: 'Fill Search with "Seven Shores Cafe"', onAccept, onDismiss, ...over });

  it('says exactly what the action said, and shows one Tab keycap', () => {
    show();
    expect(chip.visible).toBe(true);
    expect(chip.text).toBe('Fill Search with "Seven Shores Cafe"');
    expect(hosts()).toHaveLength(1);
  });

  it('takes a right Shift tap from the target and acts once', () => {
    show();
    const e = tap(target);
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(chip.visible).toBe(false);
    tap(target);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('takes the tap even when the user is in another text field', () => {
    other.focus();
    show();
    const e = tap(other);
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('leaves Tab to the page, and takes the chip down with the focus it moves', () => {
    show();
    const e = key(target, 'Tab');
    expect(e.defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
    other.focus();
    expect(chip.visible).toBe(false);
  });

  it('does not accept a right Shift held down as part of a chord', () => {
    show();
    // Shift+Tab is caret's too, so a chord the page owns makes the point better.
    const e = chord(target, 'a');
    expect(e.defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('acts once on a held key, not once per repeat', () => {
    show();
    const down = { key: 'Shift', code: ACCEPT_KEYS.rightShift.code, location: 2, shiftKey: true, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', down));
    target.dispatchEvent(new KeyboardEvent('keydown', { ...down, repeat: true }));
    target.dispatchEvent(new KeyboardEvent('keydown', { ...down, repeat: true }));
    expect(onAccept).not.toHaveBeenCalled();
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: ACCEPT_KEYS.rightShift.code, location: 2, bubbles: true, cancelable: true }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('is not tapped by the left Shift', () => {
    show();
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', location: 1, shiftKey: true, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', location: 1, bubbles: true }));
    expect(onAccept).not.toHaveBeenCalled();
    expect(chip.visible).toBe(true);
  });

  it('dismisses on Escape, on typing in the target, and on its own after the timeout', () => {
    show();
    key(target, 'Escape');
    expect(onDismiss).toHaveBeenCalledWith('escape');

    show();
    target.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledWith('typed');

    show();
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(onDismiss).toHaveBeenCalledWith('timeout');
  });

  it('asks for a quiet minute on Shift+Tab, and stands an armed chip down first', () => {
    chip.show({ target, label: 'Click "Send reply"', irreversible: true, onAccept, onDismiss });
    tap(target);
    expect(chip.armed).toBe(true);
    const e = key(target, 'Tab', { shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(chip.armed).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledWith('snoozed');
  });

  describe('an action that cannot be undone', () => {
    const showRisky = (): void =>
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, onAccept, onDismiss });

    it('arms on the first Tab, says so, and acts on the second', () => {
      showRisky();
      tap(target);
      expect(onAccept).not.toHaveBeenCalled();
      expect(chip.armed).toBe(true);
      expect(chip.text).toBe('Press again to click "Send reply"');
      tap(target);
      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(chip.visible).toBe(false);
    });

    it('stands down after four seconds, so a later Tab only arms it again', () => {
      showRisky();
      tap(target);
      vi.advanceTimersByTime(ARM_MS);
      expect(chip.armed).toBe(false);
      expect(chip.text).toBe('Click "Send reply"');
      tap(target);
      expect(onAccept).not.toHaveBeenCalled();
      expect(chip.armed).toBe(true);
    });

    it('stands down on any other key', () => {
      showRisky();
      tap(target);
      expect(chip.armed).toBe(true);
      key(target, 'a');
      expect(chip.armed).toBe(false);
      expect(onAccept).not.toHaveBeenCalled();
    });

    it('still dismisses on Escape while armed', () => {
      showRisky();
      tap(target);
      key(target, 'Escape');
      expect(onDismiss).toHaveBeenCalledWith('escape');
      expect(onAccept).not.toHaveBeenCalled();
    });
  });

  it('rings the control it is about, keeps the ring for the whole offer, and takes it with it', () => {
    // The engine's ring, up the moment a target streams in, before there is
    // anything to say about it.
    chip.ring(target);
    expect(ring.visible).toBe(true);
    expect(ringHosts()).toHaveLength(1);
    expect(chip.visible).toBe(false);
    // The offer lands on the same ring rather than a second one.
    show();
    expect(ring.visible).toBe(true);
    expect(ringHosts()).toHaveLength(1);
    chip.hide();
    expect(ring.visible).toBe(false);
  });

  it('rings the target of every action that has one', () => {
    chip.show({ target, label: 'Click "Pay"', kind: 'click', onAccept, onDismiss });
    expect(ring.visible).toBe(true);
    tap(target);
    expect(ring.visible).toBe(false);
  });

  describe('where the pill sits', () => {
    const box = (left: number, width: number): DOMRect =>
      ({ top: 100, left, bottom: 130, right: left + width, width, height: 30 }) as DOMRect;

    it('centres the pill on the control', () => {
      // A 200px control at x=300 is centred on 400; a 300px pill starts at 250.
      expect(placeAt(box(300, 200), 300, 40, 1000, 800).left).toBe(250);
    });

    it('clamps to the viewport at either edge, so the pill is never half off screen', () => {
      expect(placeAt(box(0, 40), 300, 40, 1000, 800).left).toBe(8);
      expect(placeAt(box(960, 40), 300, 40, 1000, 800).left).toBe(1000 - 300 - 8);
    });

    it('sits under the control, and above it when there is no room below', () => {
      expect(placeAt(box(300, 200), 300, 40, 1000, 800).top).toBe(136);
      const tight = { ...box(300, 200), top: 700, bottom: 730 } as DOMRect;
      expect(placeAt(tight, 300, 40, 1000, 760).top).toBe(700 - 6 - 40);
    });

    it('is nowhere when the control has scrolled off any edge', () => {
      expect(placeAt(box(-400, 200), 300, 40, 1000, 800).visible).toBe(false);
      expect(placeAt(box(1200, 200), 300, 40, 1000, 800).visible).toBe(false);
    });

    it('puts the pill on the control it is about', () => {
      show();
      const host = hosts()[0] as HTMLElement;
      // jsdom lays nothing out, so the pill measures zero wide: its left edge
      // is its centre, and that is the control's centre.
      expect(host.style.left).toBe('120px');
      expect(host.style.top).toBe('136px');
    });

    it('follows its control when a container scrolls under it, within one frame', () => {
      const scroller = document.createElement('div');
      document.body.append(scroller);
      scroller.append(target);
      show();
      expect((hosts()[0] as HTMLElement).style.top).toBe('136px');

      // The container scrolls: the event reaches the window in the capture phase.
      onScreen(target, 40, 20);
      scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
      expect((hosts()[0] as HTMLElement).style.top).toBe('76px');

      // And a shift that fires no event at all is picked up on the next frame.
      onScreen(target, 40, 300);
      vi.advanceTimersByTime(FRAME_MS);
      expect((hosts()[0] as HTMLElement).style.left).toBe('400px');
    });

    it('goes when its control leaves the viewport and comes back when it returns', () => {
      show();
      onScreen(target, -400);
      vi.advanceTimersByTime(FRAME_MS);
      expect((hosts()[0] as HTMLElement).style.display).toBe('none');
      onScreen(target, 100);
      vi.advanceTimersByTime(FRAME_MS);
      expect((hosts()[0] as HTMLElement).style.display).toBe('block');
      expect((hosts()[0] as HTMLElement).style.top).toBe('136px');
    });
  });

  it('sits at the bottom centre as a banner, and takes Tab from anywhere', () => {
    chip.showBanner({ label: 'Scroll down', onAccept, onDismiss });
    const host = hosts()[0] as HTMLElement;
    expect(host.style.bottom).toBe(`${CORNER_INSET_PX}px`);
    expect(host.style.left).toBe('50%');
    expect(chip.text).toBe('Scroll down');
    const e = tap(document.body);
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('falls back to the banner when the target has nowhere on screen to sit', () => {
    // A field in a cross-origin frame the top window cannot see: the anchor
    // reports it off screen, so a chip mounted on it would eat Tab and show
    // nothing. The banner is somewhere, and somewhere beats nowhere.
    chip.show({ target, label: 'Click "Pay"', onAccept, onDismiss, anchor: () => null });
    const host = hosts()[0] as HTMLElement;
    expect(chip.visible).toBe(true);
    expect(host.style.display).toBe('block');
    expect(host.style.bottom).toBe(`${CORNER_INSET_PX}px`);
    const e = tap(document.body);
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  describe('the accept key setting', () => {
    it('takes Tab once the setting says so, and leaves the right Shift alone', () => {
      chip.setAcceptKey('tab');
      show();
      const e = key(target, 'Tab');
      expect(e.defaultPrevented).toBe(true);
      expect(onAccept).toHaveBeenCalledTimes(1);

      show();
      tap(target);
      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(chip.visible).toBe(true);
    });

    it('puts the key it now answers to on the cap', () => {
      show();
      expect(chip.keycap.glyph).toBe(ACCEPT_KEYS.rightShift.glyph);
      chip.setAcceptKey('tab');
      expect(chip.keycap.glyph).toBe(ACCEPT_KEYS.tab.glyph);
      expect(chip.keycap.name).toBe(ACCEPT_KEYS.tab.label);
      chip.setAcceptKey('rightShift');
      expect(chip.keycap.glyph).toBe(ACCEPT_KEYS.rightShift.glyph);
    });

    it('still gives Shift+Tab the quiet minute rather than an accept', () => {
      chip.setAcceptKey('tab');
      show();
      const e = key(target, 'Tab', { shiftKey: true });
      expect(e.defaultPrevented).toBe(true);
      expect(onAccept).not.toHaveBeenCalled();
      expect(onDismiss).toHaveBeenCalledWith('snoozed');
    });

    it('arms an irreversible action on the first Tab and acts on the second', () => {
      chip.setAcceptKey('tab');
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, onAccept, onDismiss });
      key(target, 'Tab');
      expect(chip.armed).toBe(true);
      expect(onAccept).not.toHaveBeenCalled();
      key(target, 'Tab');
      expect(onAccept).toHaveBeenCalledTimes(1);
    });

    it('hands Tab back to the page when the setting goes back', () => {
      chip.setAcceptKey('tab');
      chip.setAcceptKey('rightShift');
      show();
      const e = key(target, 'Tab');
      expect(e.defaultPrevented).toBe(false);
      expect(onAccept).not.toHaveBeenCalled();
    });
  });

  describe('the Tab keycap', () => {
    it("is set in the label's size", () => {
      expect(KEYCAP.fontPx).toBe(TYPE.fontPx);
      expect(CHIP_CSS).toContain(`font: 600 ${KEYCAP.fontPx}px/1`);
    });

    it('centres the ink rather than the em box, so the cap sits on the line', () => {
      // A cap and an arrow have nothing below the baseline; the descender
      // space the font reserves under them would otherwise ride them high.
      expect(KEYCAP_CSS).toContain('text-box-trim: trim-both');
      expect(KEYCAP_CSS).toContain('text-box-edge: cap alphabetic');
    });

    it('never trims the label, which has descenders and a clipped overflow', () => {
      // Trimming to the baseline plus `overflow: hidden` cuts the tail off a
      // "g". The label keeps its whole line box; only the keycap is trimmed.
      const rule = CHIP_CSS.slice(CHIP_CSS.indexOf('.label {'), CHIP_CSS.indexOf('.sub {'));
      expect(rule).toContain('overflow: hidden');
      expect(rule).not.toContain('text-box-trim');
      expect(rule).not.toContain('text-box-edge');
    });

    it("is a fixed box exactly one text line tall, with the glyph centred in it", () => {
      expect(KEYCAP.heightPx).toBe(LINE_PX);
      expect(LINE_PX).toBe(TYPE.fontPx * TYPE.lineHeight);
      expect(CHIP_CSS).toContain(`height: ${LINE_PX}px`);
      expect(CHIP_CSS).toContain('align-items: center');
      expect(CHIP_CSS).toContain(`.label { line-height: ${LINE_PX}px;`);
    });

    it('shows the right Shift glyph and names the key for a reader', () => {
      show();
      expect(chip.keycap.glyph).toBe(ACCEPT_KEYS.rightShift.glyph);
      expect(ACCEPT_KEYS.rightShift.glyph).toBe('R\u21E7');
      expect(chip.keycap.name).toBe(ACCEPT_KEYS.rightShift.label);
    });

    it("has a radius that fits its box and sits inside the pill's own", () => {
      expect(KEYCAP.radiusPx * 2).toBeLessThan(KEYCAP.heightPx);
      expect(KEYCAP.radiusPx).toBeLessThan(PILL.radiusPx);
    });

    it("takes the pill's box from the prototype's hint, and leaves the ring rounder", () => {
      expect(PILL.radiusPx).toBe(6);
      expect(RING.radiusPx).toBe(7);
      expect(TYPE.fontPx).toBe(12);
      expect(CHIP_CSS).toContain(`border-radius: ${PILL.radiusPx}px`);
      expect(CHIP_CSS).not.toContain('999px');
    });
  });

  describe('the user getting on with the page', () => {
    it('goes on a pointerdown anywhere but the chip', () => {
      show();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
      expect(onDismiss).toHaveBeenCalledWith('acted');
      expect(chip.visible).toBe(false);
    });

    it('stays for a bare modifier and goes for a key with something to say', () => {
      show();
      key(document.body, 'Shift');
      expect(chip.visible).toBe(true);
      key(document.body, 'j');
      expect(onDismiss).toHaveBeenCalledWith('acted');
    });

    it('stays through a wheel, a touchmove and a scroll: reading on is not an answer', () => {
      for (const type of ['wheel', 'touchmove', 'scroll']) {
        show();
        window.dispatchEvent(new Event(type));
        vi.advanceTimersByTime(FRAME_MS);
        window.dispatchEvent(new Event(type));
        expect([type, chip.visible]).toEqual([type, true]);
        expect(onDismiss).not.toHaveBeenCalled();
        chip.hide();
        onDismiss.mockClear();
      }
    });

    it('goes off screen with its control and comes back with it, without being asked again', () => {
      show();
      const host = hosts()[0] as HTMLElement;
      expect(host.style.display).not.toBe('none');

      // The control scrolls off the top of the page.
      offScreen(target);
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(FRAME_MS);
      expect(host.style.display).toBe('none');
      expect(chip.visible).toBe(true);
      expect(onDismiss).not.toHaveBeenCalled();

      // And back. The same offer is on the same control: nothing was re-shown.
      onScreen(target);
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(FRAME_MS);
      expect(host.style.display).toBe('block');
      expect(chip.text).toBe('Fill Search with "Seven Shores Cafe"');
    });

    it('does not run out of time while it is off screen', () => {
      show();
      offScreen(target);
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(FRAME_MS);

      // Long past the point an answered-nowhere chip would have given up.
      vi.advanceTimersByTime(AUTO_DISMISS_MS * 3);
      expect(chip.visible).toBe(true);
      expect(onDismiss).not.toHaveBeenCalled();

      // The clock starts again when it is back, and then it does give up.
      onScreen(target);
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(FRAME_MS);
      expect(chip.visible).toBe(true);
      vi.advanceTimersByTime(AUTO_DISMISS_MS);
      expect(onDismiss).toHaveBeenCalledWith('timeout');
    });

    it('goes when the focus lands on another control, and stays for the field it was filling', () => {
      chip.show({ target, label: 'Click "Save"', interceptFrom: other, onAccept, onDismiss });
      other.focus();
      expect(chip.visible).toBe(true);
      const third = document.createElement('input');
      document.body.append(third);
      third.focus();
      expect(onDismiss).toHaveBeenCalledWith('acted');
    });

    it('lets Esc and typing say their piece, and never reports the rest', () => {
      show();
      key(target, 'Escape');
      expect(onDismiss).toHaveBeenLastCalledWith('escape');
      show();
      target.dispatchEvent(new Event('input', { bubbles: true }));
      expect(onDismiss).toHaveBeenLastCalledWith('typed');
    });
  });

  it('stays pending until it settles, and puts the reason on the tooltip', () => {
    show({ pending: true, reason: 'the note names the place' });
    expect(chip.pending).toBe(true);
    chip.settle();
    expect(chip.pending).toBe(false);
  });

  it('puts nothing on the pill for pending: no dot, no spinner', () => {
    show({ pending: true });
    expect(chip.pending).toBe(true);
    expect(CHIP_CSS).not.toContain('.pending');
    expect(chip.classes).not.toContain('pending');
  });

  it('loops nothing at all', () => {
    expect(CHIP_CSS).not.toContain('infinite');
    expect(FX_CSS).not.toContain('infinite');
  });

  it('relays a key heard inside a child frame', () => {
    chip.showBanner({ label: 'Click "Pay now"', irreversible: true, onAccept, onDismiss });
    chip.relay('RightShift');
    expect(chip.armed).toBe(true);
    chip.relay('RightShift');
    expect(onAccept).toHaveBeenCalledTimes(1);

    chip.showBanner({ label: 'Scroll down', onAccept, onDismiss });
    chip.relay('Escape');
    expect(onDismiss).toHaveBeenLastCalledWith('escape');
  });

  it('leaves nothing behind when destroyed', () => {
    show();
    chip.ring(target);
    chip.destroy();
    expect(hosts()).toHaveLength(0);
    expect(ringHosts()).toHaveLength(0);
    expect(document.querySelectorAll('[data-caret-fx]')).toHaveLength(0);
  });

  describe('how it feels', () => {
    it('fades up on arrival, with no glow ring behind it', () => {
      show();
      expect(chip.classes).toContain('is-entering');
      expect(chip.classes).not.toContain('has-glow');
      vi.advanceTimersByTime(TIMING.enterMs);
      expect(chip.classes).not.toContain('is-entering');
    });

    it('cancels the arrival when the chip goes mid-fade', () => {
      show();
      vi.advanceTimersByTime(TIMING.enterMs / 2);
      key(target, 'Escape');
      expect(chip.classes).not.toContain('is-entering');
      // Esc is the user answering, so the chip has a moment to get out of the way.
      expect(chip.classes).toContain('is-leaving');
      vi.advanceTimersByTime(TIMING.exitMs);
      expect(chip.classes).not.toContain('is-leaving');
    });

    it('leaves the same way whatever the action was', () => {
      for (const kind of ['click', 'scroll', 'open'] as const) {
        chip.showBanner({ label: 'Do the thing', kind, onAccept, onDismiss });
        tap(document.body);
        expect([kind, chip.classes.includes('is-leaving')]).toEqual([kind, true]);
        expect(chip.classes.filter((c) => c.startsWith('exit-'))).toEqual([]);
        vi.advanceTimersByTime(TIMING.exitMs);
        expect([kind, chip.classes.includes('is-leaving')]).toEqual([kind, false]);
      }
    });

    it('keeps every animation short, still and one-shot', () => {
      const durations = [...CHIP_CSS.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
      expect(durations.length).toBeGreaterThan(0);
      expect(Math.max(...durations)).toBeLessThanOrEqual(200);
      // The only movement left is the 2px the pill rises on arrival.
      const shifts = [...CHIP_CSS.matchAll(/translateY\((-?[\d.]+)px\)/g)].map((m) => Math.abs(Number(m[1])));
      expect(Math.max(0, ...shifts)).toBeLessThanOrEqual(2);
      expect(CHIP_CSS).not.toContain('scale(');
    });

    it('gets on with the page instantly when the user does, with no exit at all', () => {
      show();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
      expect(chip.classes).not.toContain('is-leaving');
    });

    it('marks itself armed without taking on a colour, and drops the mark when it stands down', () => {
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, kind: 'click', onAccept, onDismiss });
      tap(target);
      expect(chip.classes).toContain('is-armed');
      expect(chip.classes).not.toContain('is-breathing');
      // The pill keeps its own colour: the red ring on the control is the warning.
      expect(CHIP_CSS).not.toContain('.chip.is-armed {');
      expect(CHIP_CSS).not.toContain('--caret-amber');
      vi.advanceTimersByTime(ARM_MS);
      expect(chip.classes).not.toContain('is-armed');
    });

    it('leaves the same way on the second Tab, with no colour to carry out', () => {
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, kind: 'click', onAccept, onDismiss });
      tap(target);
      tap(target);
      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(chip.classes).toContain('is-leaving');
      expect(chip.classes).not.toContain('is-armed');
      vi.advanceTimersByTime(TIMING.exitMs);
      expect(chip.classes).not.toContain('is-leaving');
    });

    it('does nothing at all while it waits to be answered', () => {
      show();
      vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
      expect(chip.visible).toBe(true);
      for (const cls of KEYFRAME_CLASSES) expect(chip.classes).not.toContain(cls);
    });

    it('leaves the arrival mark to the ring, and outlines the control once the offer is taken', () => {
      const fx = (): string => document.querySelector('[data-caret-fx]')?.getAttribute('data-caret-fx') ?? '';
      chip.show({ target, label: 'Fill Search with "x"', kind: 'fill', onAccept, onDismiss });
      expect(fx()).toBe('');
      tap(target);
      // One outline, no tint and no ripple, and it is gone inside 200ms.
      expect(fx()).toBe('flash');
      vi.advanceTimersByTime(TIMING.flashMs);
      expect(fx()).toBe('');
    });
  });

  describe('when the user has asked for less motion', () => {
    beforeEach(() => askedForLessMotion(true));

    it('says the same things standing still', () => {
      show();
      expect(chip.classes).toContain('is-still');
      for (const cls of KEYFRAME_CLASSES) expect(chip.classes).not.toContain(cls);
    });

    it('arms and goes without an exit', () => {
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, kind: 'click', onAccept, onDismiss });
      tap(target);
      expect(chip.classes).toContain('is-armed');
      expect(chip.classes).not.toContain('is-breathing');
      tap(target);
      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(chip.classes).not.toContain('is-leaving');
    });

    it('still marks the control it acted on, standing still', () => {
      chip.show({ target, label: 'Click "Pay"', kind: 'click', onAccept, onDismiss });
      tap(target);
      expect(document.querySelector('[data-caret-fx]')?.getAttribute('data-caret-fx')).toBe('flash');
    });
  });

  describe('the sound on Tab', () => {
    beforeEach(() => {
      FakeAudioContext.built = 0;
      vi.stubGlobal('AudioContext', FakeAudioContext);
    });

    it('builds no AudioContext until a Tab has actually been pressed', () => {
      show();
      vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
      expect(FakeAudioContext.built).toBe(0);
      tap(target);
      expect(FakeAudioContext.built).toBe(1);
    });

    it('builds none at all with the sound turned off', () => {
      chip.setSound(false);
      show();
      tap(target);
      show();
      key(target, 'Escape');
      expect(FakeAudioContext.built).toBe(0);
    });

    it('reuses the one context across arming and accepting', () => {
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, onAccept, onDismiss });
      tap(target);
      expect(FakeAudioContext.built).toBe(1);
      tap(target);
      expect(FakeAudioContext.built).toBe(1);
    });
  });
});
