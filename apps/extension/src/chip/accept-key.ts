/**
 * Carat's key: a tap of the right Shift.
 *
 * A tap is the key pressed and let go with nothing pressed in between and no
 * other modifier held down. Taken that way the key costs the page nothing:
 * Shift+Tab, Shift+click and every capital letter still reach it, because a
 * chord is not a tap. That is what frees Tab to go on being the browser's.
 */

/** `code`, not `key`: only `code` tells the two Shifts apart. */
export const ACCEPT_CODE = 'ShiftRight';
/** What the keycap shows. */
export const ACCEPT_GLYPH = 'R⇧';
/** What to call the key in prose and to a screen reader. */
export const ACCEPT_KEY_NAME = 'Right Shift';

export interface Tap {
  /**
   * Every keydown the surface hears. True when the key is the right Shift
   * itself, which is never anything else's to act on.
   */
  keydown(e: KeyboardEvent): boolean;
  /** True when this keyup ends a tap, and so means accept. */
  keyup(e: KeyboardEvent): boolean;
  /** A click, a new chip, a surface going away: whatever is held is not a tap. */
  cancel(): void;
}

/** One latch, held between the way down and the way up. */
export function watchTap(): Tap {
  let held = false;
  return {
    keydown(e) {
      if (e.code !== ACCEPT_CODE) {
        held = false;
        return false;
      }
      // An auto-repeat is a hold, not a second tap, and leaves the latch as it is.
      if (!e.repeat) held = !e.ctrlKey && !e.altKey && !e.metaKey;
      return true;
    },
    keyup(e) {
      if (e.code !== ACCEPT_CODE) return false;
      const tapped = held;
      held = false;
      return tapped;
    },
    cancel() {
      held = false;
    },
  };
}
