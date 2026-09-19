import { isInput, isTextArea, windowOf } from '../dom/tags';

export type TextControl = HTMLInputElement | HTMLTextAreaElement;

export function isTextControl(el: Element | null): el is TextControl {
  return isInput(el) || isTextArea(el);
}

/**
 * React and similar libraries replace `value` on the instance with a tracker
 * so they can tell their own writes from the user's. Writing through the
 * prototype setter bypasses that tracker, so the following `input` event
 * looks like real typing and the framework picks the new value up.
 */
export function fillTextControl(el: TextControl, value: string): void {
  // The setter comes from the element's own window: a field in a child frame is not an instance of this one's classes.
  const win = windowOf(el);
  const proto = isTextArea(el)
    ? (win?.HTMLTextAreaElement.prototype ?? HTMLTextAreaElement.prototype)
    : (win?.HTMLInputElement.prototype ?? HTMLInputElement.prototype);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

  el.focus();
  if (setter) setter.call(el, value);
  else el.value = value;

  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  try {
    el.setSelectionRange(value.length, value.length);
  } catch {
    // email/number inputs throw on setSelectionRange; the value is already set.
  }
}
