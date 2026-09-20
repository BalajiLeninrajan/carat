import type { Settings } from '@carat/shared';
import { LIMITS, hashText, isDenylisted, looksSecret, normalizeWhitespace, truncate } from '@carat/shared';
import { shortValue } from '../history';
import type { HistoryEntry } from '../history';
import type { CopiedText, Note, Notes } from './notes';

/** The origin a copy made outside the browser is filed under. */
export const SYSTEM_ORIGIN = 'clipboard';

export const CLIPBOARD_TIMING = {
  /** Least time between two reads of the system clipboard. */
  minGapMs: 5000,
  chars: LIMITS.clipboardTextChars,
} as const;

/** Where a copy goes: one note, and one line in the tab's timeline. */
export interface CopySink {
  notes: Pick<Notes, 'noteCopied'>;
  history?: { record(tabId: number, entry: HistoryEntry): Promise<void> };
  now?: () => number;
}

/**
 * Remember one copy. The note is the whole text, up to a thousand characters;
 * the timeline gets the first 24 so `copied "Seven Shores Cafe"` reads beside
 * the clicks and the typing around it.
 */
export async function rememberCopy(copy: CopiedText, sink: CopySink): Promise<Note | null> {
  const note = await sink.notes.noteCopied(copy);
  if (!note) return null;
  const tabId = copy.tabId;
  if (sink.history && tabId !== undefined && tabId >= 0) {
    await sink.history
      .record(tabId, { t: sink.now?.() ?? note.at, kind: 'copied', text: shortValue(note.text) })
      .catch(() => undefined);
  }
  return note;
}

/** What came of one poll of the system clipboard. The debug line and the tests read it. */
export type ClipboardVerdict =
  | 'off'
  | 'no-permission'
  | 'blocked'
  | 'too-soon'
  | 'empty'
  | 'unchanged'
  | 'secret'
  | 'read';

/** The offscreen document, which is the only context allowed to read the clipboard. */
export interface ClipboardDocument {
  /** Create the document if it is not up, paste into it, and answer with the text. */
  read(): Promise<string>;
  /** Take the document down: the setting went off, or carat was cleared. */
  close(): Promise<void>;
}

/** The active tab as the reader needs to judge it. */
export interface ActiveTab {
  id?: number;
  url?: string;
}

export interface ClipboardReaderDeps {
  settings: () => Promise<Pick<Settings, 'enabled' | 'clipboardRead'>>;
  /** Whether Chrome has actually granted the optional permission. */
  granted: () => Promise<boolean>;
  doc: ClipboardDocument;
  activeTab: () => Promise<ActiveTab | undefined>;
  /** True while the content script last said this tab shows a password field. */
  passwordTab?: (tabId: number) => boolean;
  remember: (copy: CopiedText) => Promise<unknown>;
  now?: () => number;
}

export interface ClipboardReader {
  /** Read the clipboard if every gate allows it. Answers with what happened. */
  poll(tab?: ActiveTab): Promise<ClipboardVerdict>;
  /** The setting went off, or carat was cleared: forget the hash and take the document down. */
  forget(): Promise<void>;
}

/**
 * The system clipboard, read on tab activation and on a top-frame commit,
 * which is when what the user copied elsewhere is about to be useful. Off
 * unless the user turns it on and Chrome grants `clipboardRead`.
 *
 * Three things keep it cheap and quiet. At most one read every five seconds,
 * whatever fires. Only the hash of the last text is kept between reads, so
 * carat holds no copy of the clipboard beyond the note it decided to store.
 * And a clipboard is never read while the tab in front is on a denylisted
 * host or showing a password field: a paste target that sensitive is not
 * worth a note.
 */
export function createClipboardReader(deps: ClipboardReaderDeps): ClipboardReader {
  const now = deps.now ?? (() => Date.now());
  let lastAt = 0;
  let lastHash: number | undefined;

  async function poll(tab?: ActiveTab): Promise<ClipboardVerdict> {
    const settings = await deps.settings();
    if (!settings.enabled || !settings.clipboardRead) return 'off';
    if (!(await deps.granted())) return 'no-permission';

    const where = tab ?? (await deps.activeTab());
    if (blocked(where, deps.passwordTab)) return 'blocked';

    const at = now();
    if (at - lastAt < CLIPBOARD_TIMING.minGapMs) return 'too-soon';
    lastAt = at;

    const text = truncate(normalizeWhitespace(await deps.doc.read()), CLIPBOARD_TIMING.chars);
    if (!text) return 'empty';
    const hash = hashText(text);
    // Only the hash is kept, never the text: a clipboard carat decided not to
    // store must leave nothing behind between two reads.
    if (hash === lastHash) return 'unchanged';
    lastHash = hash;
    if (looksSecret(text)) return 'secret';

    await deps.remember({
      text,
      origin: SYSTEM_ORIGIN,
      ...(where?.id !== undefined ? { tabId: where.id } : {}),
      at,
    });
    return 'read';
  }

  return {
    poll,
    async forget() {
      lastHash = undefined;
      lastAt = 0;
      await deps.doc.close().catch(() => undefined);
    },
  };
}

/** A tab carat may not read the clipboard over: not a web page, denylisted, or a login form. */
function blocked(tab: ActiveTab | undefined, passwordTab?: (tabId: number) => boolean): boolean {
  if (!tab) return true;
  if (tab.id !== undefined && passwordTab?.(tab.id)) return true;
  let url: URL;
  try {
    url = new URL(tab.url ?? '');
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return isDenylisted(url.hostname);
}
