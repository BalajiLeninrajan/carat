import { isInput } from './tags';

/**
 * A field whose type or naming says it holds a secret, a card or a one-time
 * code. Its value never reaches the model: not in the outline, not in the
 * per-tab history, not in a note.
 */
const SECRET =
  /pass(?:word|code)|\bpin\b|\bcvc\b|\bcvv\b|security code|card ?(?:number|no)\b|\bcc-?(?:number|csc|exp)|credit ?card|account ?number|\bssn\b|\bsin\b|\botp\b|one[- ]time code|\bsecret\b|\btoken\b/i;

export function isSecretField(el: Element, name = ''): boolean {
  if (isInput(el)) {
    const type = el.type.toLowerCase();
    if (type === 'password') return true;
  }
  const words = [
    name,
    el.getAttribute('name') ?? '',
    el.getAttribute('id') ?? '',
    el.getAttribute('autocomplete') ?? '',
    el.getAttribute('placeholder') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('data-testid') ?? '',
  ].join(' ');
  return SECRET.test(words);
}
