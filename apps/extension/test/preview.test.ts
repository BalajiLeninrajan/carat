import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextAction, NextActionRequest } from '@carat/shared';
import { PREVIEW_DELAY_MS, previewLine } from '../src/chip/preview';
import { createChip, type Chip } from '../src/chip';
import { enrich } from '../src/background/orchestrate';

function action(over: Partial<NextAction> = {}): NextAction {
  return { kind: 'click', target: 1, value: '', label: 'Click "Go"', irreversible: false, confidence: 0.8, reason: 'the primary action', ...over };
}

describe('previewLine', () => {
  it('names the host and the title an open would land on', () => {
    expect(previewLine({ action: action({ kind: 'open', value: 'maps:Seven Shores Cafe', destination: { host: 'maps.google.com', title: 'Search: Seven Shores Cafe' } }) })).toBe(
      'maps.google.com · Search: Seven Shores Cafe',
    );
  });

  it('falls back to the host alone when nothing names the destination', () => {
    expect(previewLine({ action: action({ kind: 'open', value: 'maps:x', destination: { host: 'maps.google.com' } }) })).toBe('maps.google.com');
  });

  it('names the tab a switch would bring forward', () => {
    expect(previewLine({ action: action({ kind: 'switch', value: '7', destination: { host: 'discord.com', title: 'general — Discord' } }) })).toBe('discord.com · general — Discord');
  });

  it('says where a fill got its value', () => {
    const source = 'from discord.com: dinner at Seven Shores Cafe, Friday at 6?';
    expect(previewLine({ action: action({ kind: 'fill', value: 'Seven Shores Cafe', source }) })).toBe(source);
  });

  it('leaves a fill with no known source one line', () => {
    expect(previewLine({ action: action({ kind: 'fill', value: 'Seven Shores Cafe' }) })).toBe('');
  });

  it('gives a click the control and, for a link, where it goes', () => {
    expect(previewLine({ action: action(), control: { role: 'button', name: 'Continue to payment' } })).toBe('button "Continue to payment"');
    expect(previewLine({ action: action(), control: { role: 'link', name: 'DoorDash Food Delivery', host: 'doordash.com' } })).toBe('link "DoorDash Food Delivery" · doordash.com');
  });

  it('says how much page a scroll has left', () => {
    expect(previewLine({ action: action({ kind: 'scroll', target: null }), below: 1.63 })).toBe('1.6 screens below');
    expect(previewLine({ action: action({ kind: 'scroll', target: null }), below: 0 })).toBe('');
  });
});

describe('chip preview', () => {
  let chip: Chip;
  let target: HTMLInputElement;
  let restoreMatchMedia: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    target = document.createElement('input');
    target.getBoundingClientRect = () => ({ top: 100, left: 20, bottom: 130, right: 220, width: 200, height: 30 }) as DOMRect;
    document.body.append(target);
    chip = createChip();
  });

  afterEach(() => {
    chip.destroy();
    document.body.innerHTML = '';
    restoreMatchMedia?.();
    restoreMatchMedia = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const show = (preview = '1.6 screens below'): void =>
    chip.show({ target, label: 'Scroll down', preview, onAccept: () => undefined, onDismiss: () => undefined });

  function chipHost(): Element {
    const el = document.querySelector('[data-carat-chip]');
    if (!el) throw new Error('no chip on the page');
    return el;
  }

  /** The root is closed and `pointerenter` does not bubble, so it is dispatched at the host. */
  const hover = (): void => void chipHost().dispatchEvent(new Event('pointerenter'));
  const leave = (): void => void chipHost().dispatchEvent(new Event('pointerleave'));

  it('shows nothing until the pointer has rested on the chip', () => {
    show();
    expect(chip.preview).toBe('');
    vi.advanceTimersByTime(10_000);
    expect(chip.preview).toBe('');
  });

  it('opens the preview a quarter second after the pointer arrives, and closes it on leave', () => {
    show();
    hover();
    vi.advanceTimersByTime(PREVIEW_DELAY_MS - 1);
    expect(chip.preview).toBe('');
    vi.advanceTimersByTime(1);
    expect(chip.preview).toBe('1.6 screens below');
    leave();
    expect(chip.preview).toBe('');
  });

  it('opens on focus too', () => {
    show();
    chipHost().dispatchEvent(new Event('focusin'));
    vi.advanceTimersByTime(PREVIEW_DELAY_MS);
    expect(chip.preview).toBe('1.6 screens below');
  });

  it('has nothing to open when the action had no preview line', () => {
    show('');
    hover();
    vi.advanceTimersByTime(PREVIEW_DELAY_MS * 4);
    expect(chip.preview).toBe('');
  });

  it('never opens on a device that can only be touched', () => {
    // jsdom has no matchMedia at all, which is why the chip treats a missing
    // one as "this thing hovers"; a phone answers the coarse query instead.
    const had = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (q: string) => ({ matches: q === '(hover: none) and (pointer: coarse)', media: q }) as MediaQueryList,
    });
    restoreMatchMedia = () => {
      if (had) Object.defineProperty(window, 'matchMedia', had);
      else delete (window as { matchMedia?: unknown }).matchMedia;
    };
    show();
    hover();
    vi.advanceTimersByTime(PREVIEW_DELAY_MS * 4);
    expect(chip.preview).toBe('');
  });

  it('closes the preview when the chip goes away', () => {
    show();
    hover();
    vi.advanceTimersByTime(PREVIEW_DELAY_MS);
    expect(chip.preview).toBe('1.6 screens below');
    chip.hide();
    expect(chip.preview).toBe('');
  });
});

describe('enrich', () => {
  const req = (over: Partial<NextActionRequest> = {}): NextActionRequest => ({
    page: { host: 'discord.com', title: 'Discord', path: '/channels/1', scroll: { y: 0, pages: 1, more: false } },
    outline: '',
    controls: [],
    history: [],
    notes: [],
    tabs: [],
    now: new Date(0).toISOString(),
    eagerness: 'eager',
    ...over,
  });

  it('finds the note a fill value was read from', () => {
    const notes = ['2m ago: dinner at Seven Shores Cafe, Friday at 6? (read on discord.com)'];
    const out = enrich(action({ kind: 'fill', value: 'Seven Shores Cafe' }), req({ notes }));
    expect(out?.source).toBe('from discord.com: dinner at Seven Shores Cafe, Friday at 6?');
  });

  it('falls back to the timeline, and clips the line at eighty characters', () => {
    const history = [`30s ago: typed "Seven Shores Cafe" into ${'a very long field name '.repeat(5)}`];
    const out = enrich(action({ kind: 'fill', value: 'Seven Shores Cafe' }), req({ history }));
    expect(out?.source?.startsWith('from this tab: 30s ago: typed "Seven Shores Cafe"')).toBe(true);
    expect(out?.source?.length).toBeLessThanOrEqual(80);
  });

  it('leaves a value nothing carried without a source', () => {
    expect(enrich(action({ kind: 'fill', value: 'Seven Shores Cafe' }), req())?.source).toBeUndefined();
  });

  it('names where an open lands, preferring a tab already showing it', () => {
    const plain = enrich(action({ kind: 'open', target: null, value: 'maps:Seven Shores Cafe' }), req());
    expect(plain?.destination?.title).toBe('Google Maps: Seven Shores Cafe');
    const open = enrich(action({ kind: 'open', target: null, value: 'maps:Seven Shores Cafe' }), req({ tabs: [{ id: 3, host: 'maps.google.com', title: 'Seven Shores Cafe - Google Maps' }] }));
    expect(open?.destination).toEqual({ host: 'maps.google.com', title: 'Seven Shores Cafe - Google Maps' });
  });

  it('names the tab a switch would bring forward', () => {
    const tabs = [{ id: 9, host: 'discord.com', title: 'general — Discord' }];
    expect(enrich(action({ kind: 'switch', target: null, value: '9' }), req({ tabs }))?.destination).toEqual({ host: 'discord.com', title: 'general — Discord' });
  });

  it('hands back the same object once there is nothing left to add', () => {
    const notes = ['2m ago: dinner at Seven Shores Cafe, Friday at 6? (read on discord.com)'];
    const once = enrich(action({ kind: 'fill', value: 'Seven Shores Cafe' }), req({ notes }));
    expect(enrich(once, req({ notes }))).toBe(once);
  });
});
