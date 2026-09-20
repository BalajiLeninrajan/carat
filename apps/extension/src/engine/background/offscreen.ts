/**
 * Ours: a service worker has no DOM, and two things Caret does need one. The
 * clipboard is read through a page, and the microphone is held by one. Chrome
 * allows exactly one offscreen document per extension, so both live in the
 * same page and this module owns it: it goes up when either wants it, is
 * stated with both reasons, and comes down only when neither does.
 */

import { sendMessage } from "../../messaging";
import type { ClipboardDocument } from "./clipboard";

/** Where WXT builds `entrypoints/offscreen/index.html`. */
export const OFFSCREEN_PATH = "offscreen.html";

export const OFFSCREEN_JUSTIFICATION =
  "Read the text the user last copied, and hold the microphone while they have listening switched on, so Caret can offer what it finds on the page they are on.";

/** The two things that want the document. Neither knows about the other. */
export type Tenant = "clipboard" | "listen";

const wanted = new Set<Tenant>();

// A create and a close must never interleave, and two tenants can arrive together.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

type OffscreenApi = typeof chrome.offscreen | undefined;

/** Put the document up, if it is not already, and say who wants it. */
export function openOffscreen(who: Tenant, api: OffscreenApi = chrome.offscreen): Promise<void> {
  return serialized(async () => {
    wanted.add(who);
    if (!api) throw new Error("no offscreen api");
    if (await api.hasDocument()) return;
    await api.createDocument({
      url: OFFSCREEN_PATH,
      // Both, always: the page serves both and the reasons are declared once,
      // when it is created, by whichever tenant got there first.
      reasons: ["CLIPBOARD", "USER_MEDIA"] as chrome.offscreen.Reason[],
      justification: OFFSCREEN_JUSTIFICATION,
    });
  });
}

/** Say this tenant is done. The document goes only when the other is done too. */
export function closeOffscreen(who: Tenant, api: OffscreenApi = chrome.offscreen): Promise<void> {
  return serialized(async () => {
    wanted.delete(who);
    if (!api || wanted.size) return;
    if (await api.hasDocument()) await api.closeDocument();
  });
}

export function chromeClipboardDocument(api: OffscreenApi = chrome.offscreen): ClipboardDocument {
  return {
    async read() {
      await openOffscreen("clipboard", api);
      const reply = await sendMessage("readClipboard", undefined);
      return reply?.text ?? "";
    },
    async close() {
      await closeOffscreen("clipboard", api);
    },
  };
}
