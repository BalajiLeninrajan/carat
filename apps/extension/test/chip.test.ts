import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ARM_MS, ATTENTION_AFTER_MS, AUTO_DISMISS_MS, CHIP_SETTLE_MS, CORNER_INSET_PX, PENDING_HINT, createChip, type Chip, type DismissReason } from '../src/chip';
import { KEYFRAME_CLASSES, TIMING } from '../src/chip/styles';
import { Ring } from '../src/engine/content/ring';

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

function hosts(): NodeListOf<Element> {
  return document.querySelectorAll('[data-carat-chip]');
}

function ringHosts(): NodeListOf<Element> {
  return document.querySelectorAll('carat-ring');
}

// jsdom reports zero-size rects; give the target a viewport position.
function onScreen(el: Element): void {
  el.getBoundingClientRect = () =>
    ({ top: 100, left: 20, bottom: 130, right: 220, width: 200, height: 30 }) as DOMRect;
}

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

  it('takes Tab from the target and acts once', () => {
    show();
    const e = key(target, 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(chip.visible).toBe(false);
    key(target, 'Tab');
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('lets Tab through when the user is in another text field', () => {
    show();
    other.focus();
    const e = key(other, 'Tab');
    expect(e.defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
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

  describe('an action that cannot be undone', () => {
    const showRisky = (): void =>
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, onAccept, onDismiss });

    it('arms on the first Tab, says so, and acts on the second', () => {
      showRisky();
      key(target, 'Tab');
      expect(onAccept).not.toHaveBeenCalled();
      expect(chip.armed).toBe(true);
      expect(chip.text).toBe('Press Tab again to click "Send reply"');
      key(target, 'Tab');
      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(chip.visible).toBe(false);
    });

    it('stands down after four seconds, so a later Tab only arms it again', () => {
      showRisky();
      key(target, 'Tab');
      vi.advanceTimersByTime(ARM_MS);
      expect(chip.armed).toBe(false);
      expect(chip.text).toBe('Click "Send reply"');
      key(target, 'Tab');
      expect(onAccept).not.toHaveBeenCalled();
      expect(chip.armed).toBe(true);
    });

    it('stands down on any other key', () => {
      showRisky();
      key(target, 'Tab');
      expect(chip.armed).toBe(true);
      key(target, 'a');
      expect(chip.armed).toBe(false);
      expect(onAccept).not.toHaveBeenCalled();
    });

    it('still dismisses on Escape while armed', () => {
      showRisky();
      key(target, 'Tab');
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
    key(target, 'Tab');
    expect(ring.visible).toBe(false);
  });

  it('sits at the bottom centre as a banner, and takes Tab from anywhere', () => {
    chip.showBanner({ label: 'Scroll down', onAccept, onDismiss });
    const host = hosts()[0] as HTMLElement;
    expect(host.style.bottom).toBe(`${CORNER_INSET_PX}px`);
    expect(host.style.left).toBe('50%');
    expect(chip.text).toBe('Scroll down');
    const e = key(document.body, 'Tab');
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
    const e = key(document.body, 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  describe('the user getting on with the page', () => {
    /** Past the window that belongs to the scroll carat did to place this chip. */
    const past = (): void => {
      vi.advanceTimersByTime(CHIP_SETTLE_MS);
    };

    it('goes on a pointerdown anywhere but the chip', () => {
      show();
      past();
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

    it('goes on a wheel, a touchmove or a scroll, but not inside its settle window', () => {
      for (const type of ['wheel', 'touchmove', 'scroll']) {
        show();
        window.dispatchEvent(new Event(type));
        expect([type, chip.visible]).toEqual([type, true]);
        past();
        window.dispatchEvent(new Event(type));
        expect([type, chip.visible]).toEqual([type, false]);
        expect(onDismiss).toHaveBeenLastCalledWith('scrolled');
      }
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

  it('carries the waiting dot until it settles, and puts the reason on the tooltip', () => {
    show({ pending: true, reason: 'the note names the place' });
    expect(chip.pending).toBe(true);
    chip.settle();
    expect(chip.pending).toBe(false);
  });

  it('relays a key heard inside a child frame', () => {
    chip.showBanner({ label: 'Click "Pay now"', irreversible: true, onAccept, onDismiss });
    chip.relay('Tab');
    expect(chip.armed).toBe(true);
    chip.relay('Tab');
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
    expect(document.querySelectorAll('[data-carat-fx]')).toHaveLength(0);
  });

  describe('how it feels', () => {
    it('springs in with one glow ring, and drops both when it settles', () => {
      show();
      expect(chip.classes).toEqual(expect.arrayContaining(['is-entering', 'has-glow']));
      vi.advanceTimersByTime(TIMING.enterMs);
      expect(chip.classes).not.toContain('is-entering');
      vi.advanceTimersByTime(TIMING.glowMs);
      expect(chip.classes).not.toContain('has-glow');
    });

    it('arrives without the ring when the offer before it was refused', () => {
      show({ retry: true });
      expect(chip.classes).toContain('is-entering');
      expect(chip.classes).not.toContain('has-glow');
    });

    it('cancels the arrival when the chip goes mid-spring', () => {
      show();
      vi.advanceTimersByTime(TIMING.enterMs / 2);
      key(target, 'Escape');
      expect(chip.classes).not.toContain('is-entering');
      expect(chip.classes).not.toContain('has-glow');
      // Esc is the user answering, so the chip has a moment to get out of the way.
      expect(chip.classes).toEqual(expect.arrayContaining(['is-leaving', 'exit-soft']));
      vi.advanceTimersByTime(TIMING.dismissMs);
      expect(chip.classes).not.toContain('is-leaving');
    });

    it('leaves the way the action goes', () => {
      chip.show({ target, label: 'Click "Pay"', kind: 'click', onAccept, onDismiss });
      key(target, 'Tab');
      expect(chip.classes).toEqual(expect.arrayContaining(['is-leaving', 'exit-collapse']));
      vi.advanceTimersByTime(TIMING.collapseMs);

      chip.showBanner({ label: 'Scroll down', kind: 'scroll', onAccept, onDismiss });
      key(document.body, 'Tab');
      expect(chip.classes).toContain('exit-sweep');
      vi.advanceTimersByTime(TIMING.sweepMs);

      chip.showBanner({ label: 'Open "Seven Shores Cafe" in Google Maps', kind: 'open', onAccept, onDismiss });
      key(document.body, 'Tab');
      expect(chip.classes).toContain('exit-shrink');
    });

    it('gets on with the page instantly when the user does, with no exit at all', () => {
      show();
      vi.advanceTimersByTime(CHIP_SETTLE_MS);
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
      expect(chip.classes).not.toContain('is-leaving');
    });

    it('breathes while armed and stops when it stands down', () => {
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, kind: 'click', onAccept, onDismiss });
      key(target, 'Tab');
      expect(chip.classes).toEqual(expect.arrayContaining(['is-armed', 'is-breathing']));
      vi.advanceTimersByTime(ARM_MS);
      expect(chip.classes).not.toContain('is-breathing');
      expect(chip.classes).not.toContain('is-armed');
    });

    it('plays the accept in amber on the second Tab', () => {
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, kind: 'click', onAccept, onDismiss });
      key(target, 'Tab');
      key(target, 'Tab');
      expect(onAccept).toHaveBeenCalledTimes(1);
      // The colour stays for the exit; the breathing cannot, it animates the same pill.
      expect(chip.classes).toEqual(expect.arrayContaining(['is-armed', 'is-leaving', 'exit-collapse']));
      expect(chip.classes).not.toContain('is-breathing');
      vi.advanceTimersByTime(TIMING.collapseMs);
      expect(chip.classes).not.toContain('is-armed');
    });

    it('pulses once when nobody has answered, and never again', () => {
      show();
      expect(chip.classes).not.toContain('is-attention');
      vi.advanceTimersByTime(ATTENTION_AFTER_MS);
      expect(chip.classes).toContain('is-attention');
      vi.advanceTimersByTime(TIMING.attentionMs);
      expect(chip.classes).not.toContain('is-attention');
      // Still up, still ignored, and still only the one pulse.
      vi.advanceTimersByTime(AUTO_DISMISS_MS - ATTENTION_AFTER_MS - TIMING.attentionMs - 1);
      expect(chip.visible).toBe(true);
      expect(chip.classes).not.toContain('is-attention');
    });

    it('leaves the arrival mark to the ring, and marks the control when the offer is taken', () => {
      const fx = (): string => document.querySelector('[data-carat-fx]')?.getAttribute('data-carat-fx') ?? '';
      chip.show({ target, label: 'Fill Search with "x"', kind: 'fill', onAccept, onDismiss });
      expect(fx()).toBe('');
      key(target, 'Tab');
      // The arrival mark goes with the chip; the receipt stays a moment longer.
      expect(fx().split(' ').sort()).toEqual(['flash', 'tint']);
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

      vi.advanceTimersByTime(ATTENTION_AFTER_MS);
      expect(chip.classes).toContain('is-noticed');
      expect(chip.classes).not.toContain('is-attention');
    });

    it('arms in amber without breathing, and goes without an exit', () => {
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, kind: 'click', onAccept, onDismiss });
      key(target, 'Tab');
      expect(chip.classes).toContain('is-armed');
      expect(chip.classes).not.toContain('is-breathing');
      key(target, 'Tab');
      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(chip.classes).not.toContain('is-leaving');
    });

    it('leaves no ripple on a click', () => {
      chip.show({ target, label: 'Click "Pay"', kind: 'click', onAccept, onDismiss });
      key(target, 'Tab');
      expect(document.querySelector('[data-carat-fx]')?.getAttribute('data-carat-fx')).toBe('flash');
    });
  });

  describe('the sound on Tab', () => {
    beforeEach(() => {
      FakeAudioContext.built = 0;
      vi.stubGlobal('AudioContext', FakeAudioContext);
    });

    it('builds no AudioContext until a Tab has actually been pressed', () => {
      show();
      vi.advanceTimersByTime(ATTENTION_AFTER_MS);
      expect(FakeAudioContext.built).toBe(0);
      key(target, 'Tab');
      expect(FakeAudioContext.built).toBe(1);
    });

    it('builds none at all with the sound turned off', () => {
      chip.setSound(false);
      show();
      key(target, 'Tab');
      show();
      key(target, 'Escape');
      expect(FakeAudioContext.built).toBe(0);
    });

    it('reuses the one context across arming and accepting', () => {
      chip.show({ target, label: 'Click "Send reply"', irreversible: true, onAccept, onDismiss });
      key(target, 'Tab');
      expect(FakeAudioContext.built).toBe(1);
      key(target, 'Tab');
      expect(FakeAudioContext.built).toBe(1);
    });
  });
});
