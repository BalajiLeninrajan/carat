/**
 * Ours: the system clipboard, read on tab activation and on a top-frame
 * commit, which is when text copied in another app or another Chrome profile
 * is about to be useful. Off unless the user turns the setting on and Chrome
 * grants the optional `clipboardRead` permission.
 *
 * Three things keep it cheap and quiet. At most one read every five seconds,
 * whatever fires. Only a hash of the last text is kept between reads, so Carat
 * holds no copy of the clipboard beyond the note it decided to store. And it
 * never reads while the tab in front is blocked or showing a password field: a
 * paste target that sensitive is not worth a note.
 *
 * None of this reaches the decision loop. A read ends in the notes store, like
 * a page the user left behind.
 */

import { looksSecret } from "../shared/redact";
import { isBlocked, type Settings } from "../shared/settings";
import type { Copy } from "./notes";
import { COPY_CHARS } from "./notes";

/** Least time between two reads, whatever triggered them. */
export const MIN_GAP_MS = 5_000;

/** What came of one poll. The tests and the console line read it. */
export type Verdict = "off" | "no-permission" | "blocked" | "too-soon" | "empty" | "unchanged" | "secret" | "read";

/** The offscreen document, the only context in an MV3 extension that may read the clipboard. */
export interface ClipboardDocument {
  /** Create the document if it is not up, paste into it, and answer with the text. */
  read(): Promise<string>;
  /** Take the document down: the setting went off. */
  close(): Promise<void>;
}

/** The active tab, as the reader needs to judge it. */
export interface ActiveTab {
  id?: number;
  url?: string;
}

export interface ReaderDeps {
  settings: () => Promise<Settings>;
  /** Whether Chrome has actually granted the optional permission. */
  granted: () => Promise<boolean>;
  doc: ClipboardDocument;
  activeTab: () => Promise<ActiveTab | undefined>;
  /** True while the content script last said this tab shows a password field. */
  passwordTab?: (tabId: number) => boolean;
  remember: (copy: Copy) => Promise<unknown>;
  now?: () => number;
}

export interface ClipboardReader {
  /** Read the clipboard if every gate allows it. Answers with what happened. */
  poll(tab?: ActiveTab): Promise<Verdict>;
  /** The setting went off: forget the hash and take the document down. */
  forget(): Promise<void>;
}

/** Short stable hash (FNV-1a). Only this is kept of a clipboard Carat did not store. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A chrome:// page, a file: page or the new-tab page is not one to read over. */
function isWebPage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function createClipboardReader(deps: ReaderDeps): ClipboardReader {
  const now = deps.now ?? (() => Date.now());
  let lastAt = 0;
  let lastHash: number | undefined;

  async function poll(tab?: ActiveTab): Promise<Verdict> {
    const settings = await deps.settings();
    if (!settings.enabled || !settings.clipboardRead) return "off";
    if (!(await deps.granted())) return "no-permission";

    const where = tab ?? (await deps.activeTab());
    const url = where?.url ?? "";
    // The tab in front has to be an ordinary web page Carat is allowed on, and
    // not one asking for a password. A paste target that sensitive is not
    // worth a note.
    if (!isWebPage(url) || isBlocked(settings, url)) return "blocked";
    if (where?.id !== undefined && deps.passwordTab?.(where.id)) return "blocked";

    const at = now();
    if (at - lastAt < MIN_GAP_MS) return "too-soon";
    lastAt = at;

    const text = (await deps.doc.read()).replace(/\s+/g, " ").trim().slice(0, COPY_CHARS);
    if (!text) return "empty";
    const h = hash(text);
    if (h === lastHash) return "unchanged";
    lastHash = h;
    if (looksSecret(text)) return "secret";

    // url "" is what marks a note as the system clipboard's rather than a page's.
    await deps.remember({ text, url: "", title: "", at });
    return "read";
  }

  return {
    poll,
    async forget() {
      lastAt = 0;
      lastHash = undefined;
      await deps.doc.close().catch(() => undefined);
    },
  };
}
