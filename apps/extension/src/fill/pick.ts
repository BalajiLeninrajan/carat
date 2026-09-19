import { normalizeWhitespace } from '@carat/shared';
import { isVisible } from '../capture/visibility';
import { valueOf } from '../snapshot/enumerate';
import { pressKey, pressPointer, tick, waitFor } from './wait';

/** How long a combobox gets to show its list after the text went in. */
export const PICK_TIMING = { capMs: 800, pollMs: 50 } as const;

/** `done`: an option was picked. `partial`: the text is in the box but no list or no matching option showed up. */
export type PickOutcome = 'done' | 'partial';

/**
 * A combobox that opens a list to pick from, as opposed to a text box that
 * merely wears the role: it points at a listbox, says whether it is
 * expanded, or autocompletes from a list.
 */
export function isPickCombobox(el: Element): boolean {
  const box = el.getAttribute('role')?.toLowerCase() === 'combobox' ? el : el.closest('[role="combobox" i]');
  if (!box) return false;
  if (box.hasAttribute('aria-controls') || box.hasAttribute('aria-owns') || box.hasAttribute('aria-expanded')) return true;
  if (/^(?:list|both|inline)$/i.test(box.getAttribute('aria-autocomplete') ?? '')) return true;
  return /listbox/i.test(box.getAttribute('aria-haspopup') ?? '');
}

/**
 * After the text is in, wait for the list the control points at (or the
 * first visible listbox), pick the first option whose text matches the value
 * (exact, then prefix, then contains, case-insensitive), and press it. If the
 * list stays open with the typed text still in the box, ArrowDown and Enter
 * finish it the keyboard way. Nothing within the cap: the typed text stays
 * and the outcome is `partial`. One Tab, one outcome, no second pick.
 */
export async function pickFromListbox(input: Element, value: string, doc: Document = input.ownerDocument): Promise<PickOutcome> {
  const listbox = await waitFor(doc, () => findListbox(input, doc), PICK_TIMING.capMs, PICK_TIMING.pollMs);
  if (!listbox) return 'partial';
  const option = await waitFor(doc, () => matchOption(listbox, value), PICK_TIMING.capMs, PICK_TIMING.pollMs);
  if (!option) return 'partial';
  pressPointer(option);
  await tick(doc);
  if (listbox.isConnected && shown(listbox) && valueOf(input) === value) {
    pressKey(input, 'ArrowDown');
    pressKey(input, 'Enter');
  }
  return 'done';
}

/** The listbox a combobox names through aria-controls/aria-owns, else the first visible one on the page with options in it. */
export function findListbox(input: Element, doc: Document): Element | null {
  const box = input.getAttribute('role')?.toLowerCase() === 'combobox' ? input : (input.closest('[role="combobox" i]') ?? input);
  const ids = `${box.getAttribute('aria-controls') ?? ''} ${box.getAttribute('aria-owns') ?? ''} ${input.getAttribute('list') ?? ''}`.trim();
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const el = doc.getElementById(id);
    if (el && shown(el) && optionsIn(el).length > 0) return el;
  }
  for (const el of doc.querySelectorAll('[role="listbox" i]')) {
    if (shown(el) && optionsIn(el).length > 0) return el;
  }
  return null;
}

/** The first visible option whose text equals, starts with, or contains the value; the part before a comma counts too ("Toronto, ON"). */
export function matchOption(listbox: Element, value: string): Element | null {
  const options = optionsIn(listbox).filter(shown);
  if (options.length === 0) return null;
  const wanted = normalizeWhitespace(value).toLowerCase();
  const head = wanted.split(',')[0]!.trim();
  const texts = options.map((o) => normalizeWhitespace(o.getAttribute('aria-label') ?? o.textContent ?? '').toLowerCase());
  const tests: Array<(t: string) => boolean> = [
    (t) => t === wanted,
    (t) => t.startsWith(wanted),
    (t) => t.includes(wanted),
    (t) => head.length > 0 && head !== wanted && t.startsWith(head),
    (t) => head.length > 0 && head !== wanted && t.includes(head),
  ];
  for (const test of tests) {
    const idx = texts.findIndex(test);
    if (idx >= 0) return options[idx]!;
  }
  return null;
}

function optionsIn(root: Element): Element[] {
  const own = root.matches('[role="option" i]') ? [root] : [];
  return [...own, ...Array.from(root.querySelectorAll('[role="option" i]'))];
}

function shown(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  if (el.closest('[aria-hidden="true"],[hidden]')) return false;
  return isVisible(el, win);
}
