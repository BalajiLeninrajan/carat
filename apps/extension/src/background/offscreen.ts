import { sendMessage } from '../messaging';
import type { ClipboardDocument } from './clipboard';

/** Where WXT builds `entrypoints/offscreen/index.html`. */
export const OFFSCREEN_PATH = 'offscreen.html';

export const OFFSCREEN_JUSTIFICATION = 'Read the text the user last copied, so carat can offer it on the page they are on.';

/**
 * A service worker has no DOM, and the clipboard is read through one. Chrome's
 * answer is an offscreen document: an invisible page, one per extension, with
 * `CLIPBOARD` as its stated reason. It is created on the first read and left
 * up afterwards, because creating one costs more than keeping one, and it is
 * taken down when the setting goes off.
 */
export function chromeClipboardDocument(api: typeof chrome.offscreen | undefined = chrome.offscreen): ClipboardDocument {
  let opening: Promise<void> | undefined;

  async function open(): Promise<void> {
    if (!api) throw new Error('no offscreen api');
    if (await api.hasDocument()) return;
    await api.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: OFFSCREEN_JUSTIFICATION,
    });
  }

  return {
    async read() {
      // Two triggers can land together; one creation is enough for both.
      opening ??= open().finally(() => {
        opening = undefined;
      });
      await opening;
      const reply = await sendMessage('readClipboard', undefined);
      return reply?.text ?? '';
    },
    async close() {
      if (!api) return;
      if (await api.hasDocument()) await api.closeDocument();
    },
  };
}
