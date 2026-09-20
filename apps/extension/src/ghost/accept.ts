import { fillContentEditable, fillTextControl } from '../fill';
import type { GhostField } from './field';
import { caretOf } from './field';

/**
 * Tab on a ghost. The text goes in through the same path a filled chip uses,
 * so React and the editors that watch for real typing see an `input` event
 * with the value already changed, rather than a DOM node that appeared from
 * nowhere. Nothing about the overlay is inserted: what was grey a moment ago
 * is now the user's own text, and their caret sits after it.
 */
export function acceptGhost(field: GhostField, text: string): boolean {
  if (text === '') return false;
  if (field.kind === 'editable') {
    // Insert at the caret through the browser's own editing pipeline, which
    // is what a rich editor listens to. The ghost is only ever offered at the
    // end of an editor's text, which is where this puts it.
    fillContentEditable(field.el, text);
    return true;
  }
  const el = field.el;
  const value = el.value;
  const caret = caretOf(el) ?? value.length;
  fillTextControl(el, value.slice(0, caret) + text + value.slice(caret));
  const after = caret + text.length;
  try {
    el.setSelectionRange(after, after);
  } catch {
    // email and number inputs refuse; the value is in either way.
  }
  return true;
}
