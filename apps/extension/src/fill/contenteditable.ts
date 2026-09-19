import { isHtml } from '../dom/tags';

export function isContentEditable(el: Element | null): el is HTMLElement {
  if (!isHtml(el)) return false;
  const attr = el.getAttribute('contenteditable');
  if (attr !== null) return attr !== 'false';
  const role = el.getAttribute('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/**
 * execCommand is deprecated but still the only path that goes through the
 * browser's own editing pipeline, which is what rich editors listen to.
 * When it is missing or refuses, mimic that pipeline by hand: a cancelable
 * beforeinput lets an editor that manages its own DOM take over.
 */
export function fillContentEditable(el: HTMLElement, value: string): void {
  el.focus();
  placeCaretAtEnd(el);

  const doc = el.ownerDocument;
  const exec = doc.execCommand as ((id: string, ui: boolean, v: string) => boolean) | undefined;
  if (typeof exec === 'function') {
    let ok = false;
    try {
      ok = exec.call(doc, 'insertText', false, value);
    } catch {
      ok = false;
    }
    if (ok) return;
  }

  const before = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: value,
  });
  if (!el.dispatchEvent(before)) return;

  const range = currentRangeIn(el) ?? endRange(el);
  range.deleteContents();
  const node = doc.createTextNode(value);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selectRange(el, range);

  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}

function placeCaretAtEnd(el: HTMLElement): void {
  const range = endRange(el);
  // An empty editor keeps its placeholder node; selecting everything lets
  // the insert replace it rather than append after it.
  if ((el.textContent ?? '').length === 0) range.selectNodeContents(el);
  selectRange(el, range);
}

function endRange(el: HTMLElement): Range {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  return range;
}

function currentRangeIn(el: HTMLElement): Range | null {
  const sel = el.ownerDocument.defaultView?.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return el.contains(range.startContainer) ? range : null;
}

function selectRange(el: HTMLElement, range: Range): void {
  const sel = el.ownerDocument.defaultView?.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
