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
