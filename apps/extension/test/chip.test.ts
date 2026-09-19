import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AUTO_DISMISS_MS, createChip, type Chip, type DismissReason } from '../src/chip';

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function hosts(): NodeListOf<Element> {
  return document.querySelectorAll('[data-carat-chip]');
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
    chip.show({ target, value: 'Seven Shores Cafe', onAccept, onDismiss });
  });

  afterEach(() => {
    chip.destroy();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('mounts exactly one host, even across repeated shows', () => {
    chip.show({ target, value: 'again', onAccept, onDismiss });
    expect(hosts().length).toBe(1);
    expect(hosts()[0]!.parentElement).toBe(document.documentElement);
    expect(chip.visible).toBe(true);
  });

  it('accepts Tab when the target is focused and swallows the event', () => {
    target.focus();
    const pageHandler = vi.fn();
    document.addEventListener('keydown', pageHandler);
    const e = key(target, 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(pageHandler).not.toHaveBeenCalled();
    expect(chip.visible).toBe(false);
    document.removeEventListener('keydown', pageHandler);
  });

  it('accepts Tab when focus is on body', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const e = key(document.body, 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('lets Tab through when another text input has focus', () => {
    other.focus();
    const e = key(other, 'Tab');
    expect(e.defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
    expect(chip.visible).toBe(true);
  });

  it('dismisses on Escape', () => {
    target.focus();
    key(target, 'Escape');
    expect(onDismiss).toHaveBeenCalledWith('escape');
    expect(onAccept).not.toHaveBeenCalled();
    expect(chip.visible).toBe(false);
  });

  it('hide removes the listeners', () => {
    chip.hide();
    target.focus();
    const e = key(target, 'Tab');
    key(target, 'Escape');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(AUTO_DISMISS_MS + 1);
    expect(e.defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('hides when the user types into the target', () => {
    target.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledWith('typed');
    expect(chip.visible).toBe(false);
  });

  it('auto-dismisses after 20s', () => {
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledWith('timeout');
  });

  it('shows the truncated value with a Tab keycap', () => {
    const long = 'x'.repeat(60);
    chip.show({ target, value: long, onAccept, onDismiss });
    const host = hosts()[0] as HTMLElement;
    expect(host.style.display).toBe('block');
    expect(host.style.top).toBe('136px');
    expect(host.style.left).toBe('20px');
  });

  it('hides visually and ignores Tab and Escape while the target is off screen', () => {
    target.getBoundingClientRect = () =>
      ({ top: -500, left: 20, bottom: -470, right: 220, width: 200, height: 30 }) as DOMRect;
    window.dispatchEvent(new Event('scroll'));
    expect((hosts()[0] as HTMLElement).style.display).toBe('none');
    target.focus();
    const tab = key(target, 'Tab');
    const esc = key(target, 'Escape');
    expect(tab.defaultPrevented).toBe(false);
    expect(esc.defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(chip.visible).toBe(true);
  });

  it('lets Tab through when the focused text field lives inside a shadow root', () => {
    const shadowHost = document.createElement('div');
    document.body.appendChild(shadowHost);
    const inner = document.createElement('input');
    shadowHost.attachShadow({ mode: 'open' }).appendChild(inner);
    inner.focus();
    expect(document.activeElement).toBe(shadowHost);

    const e = key(inner, 'Tab', { composed: true });
    expect(e.defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('ignores Tab and Escape while an IME composition is in progress', () => {
    target.focus();
    const tab = key(target, 'Tab', { isComposing: true });
    const esc = key(target, 'Escape', { isComposing: true });
    expect(tab.defaultPrevented).toBe(false);
    expect(esc.defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
