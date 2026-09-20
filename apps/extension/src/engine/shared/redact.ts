/** Sensitive-data detection. Anything matched here never leaves the browser. */

const SENSITIVE_TYPES = new Set(["password", "hidden"]);
const SENSITIVE_AUTOCOMPLETE = /\b(cc-|current-password|new-password|one-time-code)/i;
const SENSITIVE_NAME = /pass(word|code)?|cvv|cvc|card.?number|ssn|social.?security|otp|one.?time/i;

export function isSensitiveField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el instanceof HTMLInputElement && SENSITIVE_TYPES.has(el.type)) return true;
  if (SENSITIVE_AUTOCOMPLETE.test(el.autocomplete || "")) return true;
  const hint = [el.name, el.id, el.getAttribute("aria-label") ?? ""].join(" ");
  return SENSITIVE_NAME.test(hint);
}

const MASK = "«redacted»";

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Mask card numbers, SSNs and API-key-shaped strings inside free text. */
export function maskSensitive(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhnValid(m.replace(/\D/g, "")) ? MASK : m))
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, MASK)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, MASK)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MASK);
}

// ---------------------------------------------------------------------------
// Ours: judging a string with no field behind it

/** 13 to 19 digits, grouped or not: every card scheme in use. */
const CARD = /(?:^|\s)(?:\d[ -]?){12,18}\d(?:\s|$)/;

/** The prefixes providers put on their keys, plus a long opaque run after one. */
const KEY_PREFIX = /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abposr]|AIza|ASIA|AKIA|eyJ[A-Za-z0-9_-]{10,})[-_A-Za-z0-9]{8,}/;

/** A one-word string with upper case, lower case, a digit and punctuation in it. */
const PASSWORDY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s])\S{8,64}$/;

/** A long unbroken run of key-ish characters with both cases and a digit. */
const OPAQUE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9+/=_-]{24,}$/;

/**
 * Ours: whether a string reads like a password, a card number or a key.
 *
 * Copying is not typing. A copy carries no field to judge it by, so the shape
 * of the string is all there is to go on, and this runs on top of the field
 * check the page can still make. Blunt in one direction on purpose: a missed
 * note costs a hint, a card number in the notes goes to a model.
 */
export function looksSecret(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  if (CARD.test(` ${s} `)) return true;
  if (KEY_PREFIX.test(s)) return true;
  // Anything with a space in it is prose, not a credential.
  if (/\s/.test(s)) return false;
  return PASSWORDY.test(s) || OPAQUE.test(s);
}
