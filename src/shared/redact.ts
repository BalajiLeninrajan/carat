/**
 * Page content leaves the browser, so anything that smells like a secret is
 * masked before it can reach the model — both the focused field's own text and
 * any value we read out of the accessibility tree.
 */

export const REDACTED = "«redacted»";

const SENSITIVE_NAME = /(password|passcode|pin\b|cvv|cvc|security code|card number|ssn|social security|routing|account number|secret|token|api[ _-]?key|otp|one[- ]time)/i;

const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|current-password|new-password)/i;

const NEVER_TYPES = new Set([
  "password",
  "hidden",
  "file",
  "number",
  "range",
  "color",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "checkbox",
  "radio",
  "submit",
  "button",
  "image",
  "reset",
]);

/** A field we must not read from at all. */
export function isSensitiveField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el instanceof HTMLInputElement) {
    const type = (el.type || "text").toLowerCase();
    if (NEVER_TYPES.has(type)) return true;
  }
  const autocomplete = el.getAttribute("autocomplete") || "";
  if (SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return true;
  const haystack = [
    el.getAttribute("name") || "",
    el.id,
    el.getAttribute("aria-label") || "",
    (el as HTMLInputElement).placeholder || "",
  ].join(" ");
  if (SENSITIVE_NAME.test(haystack)) return true;
  return false;
}

/** True when a label/accessible name suggests the value is a secret. */
export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Mask card numbers, SSNs and long digit runs inside free text. */
export function scrubValue(text: string): string {
  if (!text) return text;
  let out = text.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
    const digits = match.replace(/\D/g, "");
    return digits.length >= 13 && luhnValid(digits) ? REDACTED : match;
  });
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED);
  out = out.replace(/\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, REDACTED);
  return out;
}

/** Value to expose for a field we are not focused on. */
export function scrubNamedValue(name: string, value: string): string {
  if (!value) return value;
  if (isSensitiveName(name)) return REDACTED;
  return scrubValue(value);
}

export function hostIsBlocked(url: string, blocklist: string[]): boolean {
  if (!blocklist.length) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return blocklist.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^\*\./, "");
    if (!entry) return false;
    return host === entry || host.endsWith("." + entry);
  });
}
