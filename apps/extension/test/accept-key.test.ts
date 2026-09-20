import { describe, expect, it } from 'vitest';
import {
  ACCEPT_KEYS,
  ACCEPT_KEY_NAMES,
  DEFAULT_ACCEPT_KEY,
  isAcceptKeyName,
  watchAccept,
  type AcceptKeyName,
} from '../src/chip/accept-key';

const RIGHT_SHIFT = { key: 'Shift', code: ACCEPT_KEYS.rightShift.code, location: 2, shiftKey: true };
const LEFT_SHIFT = { key: 'Shift', code: 'ShiftLeft', location: 1, shiftKey: true };

const down = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', init);
const up = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keyup', init);

describe('which key carat answers to', () => {
  it('offers two, and starts on the one that costs the page nothing', () => {
    expect([...ACCEPT_KEY_NAMES]).toEqual(['rightShift', 'tab']);
    expect(DEFAULT_ACCEPT_KEY).toBe('rightShift');
    expect(ACCEPT_KEYS.rightShift.glyph).toBe('R⇧');
    expect(ACCEPT_KEYS.tab.glyph).toBe('⇥');
  });

  it('only recognises a name it actually has', () => {
    expect(isAcceptKeyName('tab')).toBe(true);
    expect(isAcceptKeyName('rightShift')).toBe(true);
    for (const junk of ['TAB', 'shift', '', 'toString', null, undefined, 3]) {
      expect(isAcceptKeyName(junk)).toBe(false);
    }
  });
});

describe('the right Shift, taken as a tap', () => {
  it('says nothing on the way down and accepts on the way up', () => {
    const w = watchAccept();
    expect(w.keydown(down(RIGHT_SHIFT))).toBe('held');
    expect(w.keyup(up(RIGHT_SHIFT))).toBe(true);
  });

  it('is not a tap once another key has been pressed under it', () => {
    const w = watchAccept();
    w.keydown(down(RIGHT_SHIFT));
    expect(w.keydown(down({ key: 'Tab', shiftKey: true }))).toBeNull();
    expect(w.keyup(up(RIGHT_SHIFT))).toBe(false);
  });

  it('is not a tap with another modifier held, or from the left Shift', () => {
    const w = watchAccept();
    w.keydown(down({ ...RIGHT_SHIFT, ctrlKey: true }));
    expect(w.keyup(up(RIGHT_SHIFT))).toBe(false);
    expect(w.keydown(down(LEFT_SHIFT))).toBeNull();
    expect(w.keyup(up(LEFT_SHIFT))).toBe(false);
  });

  it('accepts once for a key held down, not once per repeat', () => {
    const w = watchAccept();
    w.keydown(down(RIGHT_SHIFT));
    w.keydown(down({ ...RIGHT_SHIFT, repeat: true }));
    w.keydown(down({ ...RIGHT_SHIFT, repeat: true }));
    expect(w.keyup(up(RIGHT_SHIFT))).toBe(true);
    expect(w.keyup(up(RIGHT_SHIFT))).toBe(false);
  });

  it('drops what it was holding when something else takes over', () => {
    const w = watchAccept();
    w.keydown(down(RIGHT_SHIFT));
    w.cancel();
    expect(w.keyup(up(RIGHT_SHIFT))).toBe(false);
  });
});

describe('Tab, taken on the way down', () => {
  const tabbed = (): ReturnType<typeof watchAccept> => watchAccept('tab');

  it('accepts a bare Tab, and never waits for a keyup', () => {
    const w = tabbed();
    expect(w.keydown(down({ key: 'Tab' }))).toBe('accept');
    expect(w.keyup(up({ key: 'Tab' }))).toBe(false);
  });

  it('leaves every chord to the page, Shift+Tab above all', () => {
    const w = tabbed();
    expect(w.keydown(down({ key: 'Tab', shiftKey: true }))).toBeNull();
    expect(w.keydown(down({ key: 'Tab', ctrlKey: true }))).toBeNull();
    expect(w.keydown(down({ key: 'Tab', altKey: true }))).toBeNull();
    expect(w.keydown(down({ key: 'Tab', metaKey: true }))).toBeNull();
  });

  it('acts once on a held Tab rather than once per repeat', () => {
    const w = tabbed();
    expect(w.keydown(down({ key: 'Tab' }))).toBe('accept');
    expect(w.keydown(down({ key: 'Tab', repeat: true }))).toBeNull();
  });

  it('has nothing to say about the right Shift', () => {
    const w = tabbed();
    expect(w.keydown(down(RIGHT_SHIFT))).toBeNull();
    expect(w.keyup(up(RIGHT_SHIFT))).toBe(false);
  });
});

describe('switching between them', () => {
  it('carries the glyph and the name of whichever key is current', () => {
    const w = watchAccept();
    expect([w.key, w.glyph, w.label]).toEqual(['rightShift', 'R⇧', 'Right Shift']);
    w.use('tab');
    expect([w.key, w.glyph, w.label]).toEqual(['tab', '⇥', 'Tab']);
  });

  it('drops a right Shift held across the switch, so the old key cannot land', () => {
    const w = watchAccept();
    w.keydown(down(RIGHT_SHIFT));
    w.use('tab');
    expect(w.keyup(up(RIGHT_SHIFT))).toBe(false);
  });

  it('is a no-op when the setting has not moved', () => {
    const w = watchAccept();
    w.keydown(down(RIGHT_SHIFT));
    w.use(DEFAULT_ACCEPT_KEY satisfies AcceptKeyName);
    expect(w.keyup(up(RIGHT_SHIFT))).toBe(true);
  });
});
