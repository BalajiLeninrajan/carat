import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AUTO_DISMISS_MS, CORNER_INSET_PX, createChip, type Chip, type DismissReason } from '../src/chip';

// Grabbed before any test spies on it, so a spy never wraps an earlier spy.
const attachShadow = Element.prototype.attachShadow;

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

  it('reads `Fill "value"?` by default and takes a verb and a tail for interactions', () => {
    expect(chip.text).toBe('Fill "Seven Shores Cafe"?');
    const save = document.createElement('button');
    onScreen(save);
    document.body.append(save);
    chip.show({ target: save, verb: 'Click', value: 'Save', onAccept, onDismiss });
    expect(chip.text).toBe('Click "Save"?');
    chip.show({ target: save, verb: 'Set', value: 'Volume', tail: ' to 40', onAccept, onDismiss });
    expect(chip.text).toBe('Set "Volume" to 40?');
    chip.show({ target: save, verb: 'Check', value: 'Vegetarian', onAccept, onDismiss });
    expect(chip.text).toBe('Check "Vegetarian"?');
    chip.showCorner({ label: 'Open in Google Maps', value: 'Seven Shores Cafe', onAccept, onDismiss });
    expect(chip.text).toBe('Open in Google Maps: "Seven Shores Cafe"?');
  });

  it('accepts Tab from the field carat just filled and dismisses when the user types on in it', () => {
    const save = document.createElement('button');
    onScreen(save);
    document.body.append(save);
    chip.show({ target: save, verb: 'Click', value: 'Save', interceptFrom: other, onAccept, onDismiss });
    other.focus();
    other.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledWith('typed');
    expect(chip.visible).toBe(false);

    chip.show({ target: save, verb: 'Click', value: 'Save', interceptFrom: other, onAccept, onDismiss });
    const e = key(other, 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('shows the truncated value with a Tab keycap', () => {
    const long = 'x'.repeat(60);
    chip.show({ target, value: long, onAccept, onDismiss });
    const host = hosts()[0] as HTMLElement;
    expect(host.style.display).toBe('block');
    expect(host.style.top).toBe('136px');
    expect(host.style.left).toBe('20px');
  });

  it('shows the source line and reason only when given, and clears them on the next show', () => {
    // The root is closed, so catch it as it is created.
    const roots: ShadowRoot[] = [];
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
      const root = attach.call(this, init);
      roots.push(root);
      return root;
    });
    const rich = createChip();
    const root = roots[0]!;
    const shown = () => ({
      label: root.querySelector('.label')?.textContent,
      sub: root.querySelector('.sub')?.textContent,
      subHidden: (root.querySelector('.sub') as HTMLElement).hidden,
      title: root.querySelector('.chip')?.getAttribute('title'),
    });

    rich.show({ target, value: 'Seven Shores Cafe', detail: 'from discord.com · 2m ago', reason: 'named as a plan', onAccept, onDismiss });
    expect(shown()).toEqual({
      label: 'Fill "Seven Shores Cafe"?',
      sub: 'from discord.com · 2m ago',
      subHidden: false,
      title: 'named as a plan',
    });

    rich.show({ target, value: 'Plain', onAccept, onDismiss });
    expect(shown()).toEqual({ label: 'Fill "Plain"?', sub: '', subHidden: true, title: null });

    // The corner chip carries the same two lines.
    rich.showCorner({ label: 'Open in Google Maps', value: 'Seven Shores Cafe', detail: 'from this page · just now', reason: 'a place to meet', onAccept, onDismiss });
    expect(shown()).toEqual({
      label: 'Open in Google Maps: "Seven Shores Cafe"?',
      sub: 'from this page · just now',
      subHidden: false,
      title: 'a place to meet',
    });
    rich.showCorner({ label: 'Open in Google Maps', value: 'Plain', onAccept, onDismiss });
    expect(shown()).toEqual({ label: 'Open in Google Maps: "Plain"?', sub: '', subHidden: true, title: null });
    rich.destroy();
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

describe('corner chip', () => {
  let chip: Chip;
  let composer: HTMLTextAreaElement;
  let onAccept: Mock<() => void>;
  let onDismiss: Mock<(reason: DismissReason) => void>;

  let root: ShadowRoot;

  beforeEach(() => {
    vi.useFakeTimers();
    composer = document.createElement('textarea');
    document.body.append(composer);
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
      root = attachShadow.call(this, init);
      return root;
    });
    chip = createChip();
    onAccept = vi.fn<() => void>();
    onDismiss = vi.fn<(reason: DismissReason) => void>();
    chip.showCorner({ label: 'Open in Google Maps', value: 'Seven Shores Cafe', onAccept, onDismiss });
  });

  afterEach(() => {
    chip.destroy();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('sits centred at the bottom as a banner with the label, the value and a Tab keycap', () => {
    const host = hosts()[0] as HTMLElement;
    expect(host.style.display).toBe('block');
    expect(host.style.bottom).toBe(`${CORNER_INSET_PX}px`);
    expect(host.style.left).toBe('50%');
    expect(host.style.transform).toBe('translateX(-50%)');
    expect(host.style.top).toBe('auto');
    expect(host.style.right).toBe('auto');
    expect(root.querySelector('.chip')!.classList.contains('is-banner')).toBe(true);
    expect(chip.visible).toBe(true);
  });

  it('accepts Tab even while a text field has focus, and swallows it', () => {
    composer.focus();
    const pageHandler = vi.fn();
    document.addEventListener('keydown', pageHandler);
    const e = key(composer, 'Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(pageHandler).not.toHaveBeenCalled();
    expect(chip.visible).toBe(false);
    document.removeEventListener('keydown', pageHandler);
  });

  it('lets Shift+Tab through', () => {
    composer.focus();
    expect(key(composer, 'Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('dismisses on Escape and when the user types anywhere', () => {
    key(document.body, 'Escape');
    expect(onDismiss).toHaveBeenCalledWith('escape');

    chip.showCorner({ label: 'Open in Google Maps', value: 'Seven Shores Cafe', onAccept, onDismiss });
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onDismiss).toHaveBeenLastCalledWith('typed');
    expect(chip.visible).toBe(false);
  });

  it('auto-dismisses after 20s and stops listening once hidden', () => {
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(onDismiss).toHaveBeenCalledWith('timeout');
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    expect(key(document.body, 'Tab').defaultPrevented).toBe(false);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('returns to field placement when a field chip follows it', () => {
    const target = document.createElement('input');
    onScreen(target);
    document.body.append(target);
    chip.show({ target, value: 'x', onAccept, onDismiss });
    const host = hosts()[0] as HTMLElement;
    expect(host.style.right).toBe('');
    expect(host.style.bottom).toBe('');
    expect(host.style.transform).toBe('');
    expect(root.querySelector('.chip')!.classList.contains('is-banner')).toBe(false);
    expect(host.style.top).toBe('136px');
    expect(hosts().length).toBe(1);
  });
});
