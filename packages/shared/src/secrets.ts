/**
 * Whether a piece of text reads like a password, a card number or a key.
 * Copying is not typing: nothing says which field a string came from, so the
 * shape of the string is all there is to go on. Used before any copied text
 * is remembered, on top of the field check the page can still make.
 *
 * Deliberately blunt in one direction. A missed note costs a hint; a card
 * number in the notes goes to a model.
 */

/** 13 to 19 digits, in groups or not: every card scheme in use. */
const CARD = /(?:^|\s)(?:\d[ -]?){12,18}\d(?:\s|$)/;

/** The prefixes providers put on their keys, plus a long opaque run after one. */
const KEY_PREFIX = /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abposr]|AIza|ASIA|AKIA|eyJ[A-Za-z0-9_-]{10,})[-_A-Za-z0-9]{8,}/;

/** A one-word string with upper case, lower case, a digit and punctuation in it. */
const PASSWORDY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s])\S{8,64}$/;

/** A long unbroken run of key-ish characters with both cases and a digit. */
const OPAQUE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9+/=_-]{24,}$/;

export function looksSecret(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (CARD.test(` ${s} `)) return true;
  if (KEY_PREFIX.test(s)) return true;
  if (/\s/.test(s)) return false;
  return PASSWORDY.test(s) || OPAQUE.test(s);
}
