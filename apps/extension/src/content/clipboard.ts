import { LIMITS, hashText, looksSecret, normalizeWhitespace, truncate } from '@carat/shared';
import { mayCapture } from '../capture';
import { isSecretField } from '../dom/secret';
import { isInput, isTextArea } from '../dom/tags';
import type { ScriptContext } from './context';
import { send } from './send';

export const CLIPBOARD_LIMITS = {
  /** Below this a copy says nothing; a stray Ctrl+C on one character is not a fact. */
  minChars: 2,
  chars: LIMITS.clipboardTextChars,
} as const;

export interface ClipboardOptions {
  /** Runs after a copy has been sent; the suggest scheduler re-asks with it in the notes. */
  onCopied?: () => void;
}

/**
 * What the user copies on the page, as a note. No permission is needed for
 * this half: the page already fires `copy` and `cut` at the content script,
 * and the text is the selection that is about to go to the clipboard.
 *
 * The same guards the capture path uses apply. Nothing leaves a denylisted
 * host, a page with a visible password field, or a `file:` or extension page,
 * a copy made inside a password, card or code field is dropped, and text that
 * reads like a password or a card number is dropped whatever field it came
 * from. Deduplication by hash stops one Ctrl+C held down from sending twice;
 * the notes store dedupes properly, by normalised text.
 */
export function startClipboard(ctx: ScriptContext, doc: Document = document, opts: ClipboardOptions = {}): void {
  let lastHash = -1;

  const onCopy = (): void => {
    if (!ctx.isValid) return;
    if (!mayCapture(doc, doc.location)) return;
    const from = doc.activeElement;
    if (from && isSecretField(from)) return;
    const raw = normalizeWhitespace(selectedText(doc));
    if (raw.length < CLIPBOARD_LIMITS.minChars) return;
    if (looksSecret(raw)) return;
    const text = truncate(raw, CLIPBOARD_LIMITS.chars);
    const hash = hashText(text);
    if (hash === lastHash) return;
    lastHash = hash;
    void send('clipboard', { url: doc.location.href, title: doc.title, text }).then(() => opts.onCopied?.());
  };

  ctx.addEventListener(doc, 'copy', onCopy, true);
  ctx.addEventListener(doc, 'cut', onCopy, true);
}

/**
 * What the copy will carry. A selection inside an input or a textarea is not
 * part of the document's selection in every engine, so the field is read
 * directly when it is the one with focus.
 */
function selectedText(doc: Document): string {
  const el = doc.activeElement;
  if (el && (isInput(el) || isTextArea(el))) {
    try {
      // `selectionStart` throws on an input whose type has no selection, such as number or colour.
      const { selectionStart, selectionEnd } = el;
      if (typeof selectionStart === 'number' && typeof selectionEnd === 'number' && selectionEnd > selectionStart) {
        return el.value.slice(selectionStart, selectionEnd);
      }
    } catch {
      // Fall through to the document's own selection.
    }
  }
  return doc.getSelection()?.toString() ?? '';
}
