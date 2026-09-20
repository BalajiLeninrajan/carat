/**
 * Carat's key, and the choice of which key it is.
 *
 * The right Shift is the default, and it is taken as a tap: the key pressed
 * and let go with nothing pressed in between and no other modifier held. A
 * chord is never a tap, so Shift+Tab, Shift+click and every capital still
 * reach the page, and Tab goes on being the browser's.
 *
 * Tab is the other choice, for anyone who wants the editor's key. It is taken
 * on the way down and swallowed, so focus does not move while there is an
 * offer on screen to answer. That is the trade: the key is where the muscle
 * memory is, and the page loses it for as long as a chip is up.
 *
 * The two cannot be taken the same way, and the difference is the keys, not
 * the code. A modifier does nothing on its own, so waiting for the keyup
 * costs nothing, and waiting is the only way to tell a tap from the start of
 * Shift+Tab, a Shift+click or a capital letter. Tab acts the instant it goes
 * down: wait for the keyup and focus has already moved, so the default has to
 * be cancelled on the way down, and once it is there is nothing left to wait
 * for. Its chords need no waiting either, since Shift+Tab and Ctrl+Tab
 * already say what they are in the modifier flags of the keydown.
 *
 * What callers see is the same either way: one watch, one verdict, no
 * knowledge of which key is current. The chip and ghost text cannot disagree
 * about carat's key because neither of them knows what it is.
 */

export type AcceptKeyName = 'rightShift' | 'tab';

/**
 * What each key is called in a `KeyboardEvent`, on the keycap, and in prose.
 * `code`, not `key`: only `code` tells the two Shifts apart.
 */
export const ACCEPT_KEYS = {
  rightShift: { code: 'ShiftRight', glyph: 'R⇧', label: 'Right Shift' },
  tab: { code: 'Tab', glyph: '⇥', label: 'Tab' },
} as const satisfies Record<AcceptKeyName, { code: string; glyph: string; label: string }>;

export const ACCEPT_KEY_NAMES = Object.keys(ACCEPT_KEYS) as readonly AcceptKeyName[];

export const DEFAULT_ACCEPT_KEY: AcceptKeyName = 'rightShift';

/** `hasOwn`, not `in`: `in` would take "toString" for a key name. */
export function isAcceptKeyName(v: unknown): v is AcceptKeyName {
  return typeof v === 'string' && Object.hasOwn(ACCEPT_KEYS, v);
}

/**
 * What a keydown meant. `accept` is act on it now; `held` is carat's own key
 * on its way down, which nothing else should read and which decides nothing
 * until it comes back up.
 */
export type AcceptVerdict = 'accept' | 'held' | null;

export interface AcceptWatch {
  /** Which key is carat's. Switching drops whatever was half-held. */
  use(key: AcceptKeyName): void;
  readonly key: AcceptKeyName;
  readonly glyph: string;
  readonly label: string;
  keydown(e: KeyboardEvent): AcceptVerdict;
  /** True when this keyup ends a tap. Never true while Tab is the key. */
  keyup(e: KeyboardEvent): boolean;
  /** A click, a new chip, a surface going away: whatever is held is not a tap. */
  cancel(): void;
}

/** One latch, held between the way down and the way up. */
export function watchAccept(initial: AcceptKeyName = DEFAULT_ACCEPT_KEY): AcceptWatch {
  let current = initial;
  let held = false;
  return {
    get key() {
      return current;
    },
    get glyph() {
      return ACCEPT_KEYS[current].glyph;
    },
    get label() {
      return ACCEPT_KEYS[current].label;
    },
    use(next) {
      if (next === current) return;
      current = next;
      held = false;
    },
    keydown(e) {
      if (current === 'tab') {
        held = false;
        const bare = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
        // A held key repeating is one press, not a second one.
        return e.key === ACCEPT_KEYS.tab.code && bare && !e.repeat ? 'accept' : null;
      }
      if (e.code !== ACCEPT_KEYS.rightShift.code) {
        held = false;
        return null;
      }
      // An auto-repeat is a hold, not a second tap, and leaves the latch as it is.
      if (!e.repeat) held = !e.ctrlKey && !e.altKey && !e.metaKey;
      return 'held';
    },
    keyup(e) {
      if (current === 'tab' || e.code !== ACCEPT_KEYS.rightShift.code) return false;
      const tapped = held;
      held = false;
      return tapped;
    },
    cancel() {
      held = false;
    },
  };
}
