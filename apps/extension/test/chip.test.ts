import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ARM_MS, AUTO_DISMISS_MS, CHIP_SETTLE_MS, CORNER_INSET_PX, PENDING_HINT, createChip, type Chip, type DismissReason } from '../src/chip';

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function hosts(): NodeListOf<Element> {
  return document.querySelectorAll('[data-carat-chip]');
}

function rings(): NodeListOf<Element> {
  return document.querySelectorAll('[data-carat-ring]');
}

// jsdom reports zero-size rects; give the target a viewport position.
function onScreen(el: Element): void {
  el.getBoundingClientRect = () =>
    ({ top: 100, left: 20, bottom: 130, right: 220, width: 200, height: 30 }) as DOMRect;
}

describe('chip', () => {
  let chip: Chip;
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
    chip = createChip();
    onAccept = vi.fn<() => void>();
    onDismiss = vi.fn<(reason: DismissReason) => void>();
  });

  afterEach(() => {
    chip.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it('rings the control it is about, and rings one early with no chip on it yet', () => {
    chip.ring(target);
    expect(rings()).toHaveLength(1);
    expect((rings()[0] as HTMLElement).style.display).toBe('block');
    expect(chip.visible).toBe(false);
    show();
    expect((rings()[0] as HTMLElement).style.display).toBe('block');
    chip.hide();
    expect((rings()[0] as HTMLElement).style.display).toBe('none');
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
    expect(rings()).toHaveLength(0);
  });
});
