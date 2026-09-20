import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/messaging', () => ({ safeSendMessage: vi.fn(async () => undefined) }));

import type { ContextItem } from '@carat/shared';
import { CLIPBOARD_TIMING, SYSTEM_ORIGIN, createClipboardReader, rememberCopy } from '../src/background/clipboard';
import type { ClipboardReaderDeps } from '../src/background/clipboard';
import { clearAll } from '../src/background/clear';
import { HistoryStore } from '../src/background/history';
import { getKnown } from '../src/background/known';
import { NOTES_LIMITS, createNotes } from '../src/background/notes';
import type { ScriptContext } from '../src/content';
import { startClipboard } from '../src/content/clipboard';
import { safeSendMessage } from '../src/messaging';
import { ContextStore, ShotStore } from '../src/store';
import type { StorageArea } from '../src/store';
import wxtConfig from '../wxt.config';

const sent = vi.mocked(safeSendMessage);

class FakeArea implements StorageArea {
  data: Record<string, unknown> = {};
  async get(keys: string[]) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.data, structuredClone(items));
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k];
  }
}

/** Contexts handed out this test, so afterEach can stop every watcher it started. */
const live: Array<{ invalidate(): void }> = [];

function fakeCtx(): ScriptContext {
  const listeners: Array<[EventTarget, string, EventListener, unknown]> = [];
  const onInvalid: Array<() => void> = [];
  const ctx = {
    isValid: true,
    setTimeout: (fn: () => void, ms?: number) => window.setTimeout(fn, ms),
    addEventListener(target: EventTarget, type: string, handler: EventListener, options?: unknown) {
      listeners.push([target, type, handler, options]);
      target.addEventListener(type, handler, options as AddEventListenerOptions);
    },
    onInvalidated(cb: () => void) {
      onInvalid.push(cb);
      return () => undefined;
    },
    invalidate() {
      ctx.isValid = false;
      for (const [target, type, handler, options] of listeners) {
        target.removeEventListener(type, handler, options as AddEventListenerOptions);
      }
      onInvalid.forEach((cb) => cb());
    },
  };
  live.push(ctx);
  return ctx as unknown as ScriptContext;
}

/** What `document.getSelection()` answers with for the rest of the test. */
function selecting(text: string): void {
  vi.spyOn(document, 'getSelection').mockReturnValue({ toString: () => text } as unknown as Selection);
}

function copies(): Array<{ text: string; url: string; title: string }> {
  return sent.mock.calls
    .filter(([type]) => type === 'clipboard')
    .map(([, data]) => data as { text: string; url: string; title: string });
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Best brunch in Waterloo?';
  sent.mockClear();
});

afterEach(() => {
  live.splice(0).forEach((ctx) => ctx.invalidate());
  vi.restoreAllMocks();
});

describe('a copy made in the browser', () => {
  it('sends what was selected, on copy and on cut', () => {
    startClipboard(fakeCtx(), document);
    selecting('Seven Shores Cafe, 10 Regina St N');

    document.dispatchEvent(new Event('copy'));
    expect(copies()).toEqual([
      { text: 'Seven Shores Cafe, 10 Regina St N', url: document.location.href, title: document.title },
    ]);

    selecting('Friday at 6');
    document.dispatchEvent(new Event('cut'));
    expect(copies().at(-1)?.text).toBe('Friday at 6');
  });

  it('sends the field’s own selection when the focus is in an input', () => {
    document.body.innerHTML = '<input id="q" name="search" value="seven shores cafe" />';
    const input = document.getElementById('q') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 'seven shores'.length);
    startClipboard(fakeCtx(), document);
    selecting('');

    document.dispatchEvent(new Event('copy'));
    expect(copies()[0]?.text).toBe('seven shores');
  });

  it('ignores a copy out of a card, code or password field', () => {
    document.body.innerHTML = '<input id="cvv" name="cvv" value="371" />';
    const cvv = document.getElementById('cvv') as HTMLInputElement;
    cvv.focus();
    startClipboard(fakeCtx(), document);
    selecting('371');

    document.dispatchEvent(new Event('copy'));
    expect(copies()).toEqual([]);
  });

  it('ignores every copy on a page showing a password field', () => {
    document.body.innerHTML = '<input type="password" /><p>Sign in to continue</p>';
    startClipboard(fakeCtx(), document);
    selecting('Sign in to continue');

    document.dispatchEvent(new Event('copy'));
    expect(copies()).toEqual([]);
  });

  it('drops text that reads like a card number or a key, whatever field it came from', () => {
    startClipboard(fakeCtx(), document);
    for (const secret of ['4539 1488 0343 6467', 'sk-proj-1a2b3c4d5e6f7g8h9i', 'Tr0ub4dor&3']) {
      selecting(secret);
      document.dispatchEvent(new Event('copy'));
    }
    expect(copies()).toEqual([]);
  });

  it('sends one message for one text, however many copy events it takes', () => {
    startClipboard(fakeCtx(), document);
    selecting('Seven Shores Cafe');

    document.dispatchEvent(new Event('copy'));
    document.dispatchEvent(new Event('copy'));
    document.dispatchEvent(new Event('cut'));
    expect(copies()).toHaveLength(1);
  });

  it('stops when the extension reloads under the page', () => {
    const ctx = fakeCtx();
    startClipboard(ctx, document);
    selecting('Seven Shores Cafe');
    (ctx as unknown as { invalidate(): void }).invalidate();

    document.dispatchEvent(new Event('copy'));
    expect(copies()).toEqual([]);
  });
});

const PAGE_TEXT =
  'Alex asked about dinner at Seven Shores Cafe on Friday at 6, and to bring the returns slip for order NW-55821. '.repeat(
    3,
  );

function pageItem(over: Partial<ContextItem> = {}): ContextItem {
  return {
    id: 'i1',
    tabId: 4,
    origin: 'https://discord.com',
    path: '/channels/1',
    title: 'Waterloo plans',
    kind: 'page',
    text: PAGE_TEXT,
    hash: 1,
    capturedAt: 0,
    lastSeenAt: 0,
    ...over,
  };
}

function notesAt(start = 1_000_000) {
  let clock = start;
  const area = new FakeArea();
  const notes = createNotes({
    area,
    distill: async () => ['Alex asked about dinner at Seven Shores Cafe on Friday at 6.'],
    now: () => clock,
    timeoutMs: 50,
  });
  return { area, notes, tick: (ms: number) => (clock += ms), at: () => clock };
}

describe('a copy as a note', () => {
  it('is stored as it stands, with the host it was made on', async () => {
    const { notes } = notesAt();
    const note = await notes.noteCopied({ text: 'Seven Shores Cafe', origin: 'https://www.reddit.com', tabId: 3 });

    expect(note?.kind).toBe('clipboard');
    expect(await notes.top({ tabId: 3 })).toEqual(['copied just now on www.reddit.com: "Seven Shores Cafe"']);
  });

  it('says how long ago it was copied', async () => {
    const { notes, tick } = notesAt();
    await notes.noteCopied({ text: 'Seven Shores Cafe', origin: 'https://www.reddit.com', tabId: 3 });
    tick(12_000);

    expect(await notes.top({ tabId: 9 })).toEqual(['copied 12s ago on www.reddit.com: "Seven Shores Cafe"']);
  });

  it('keeps one note per distinct text', async () => {
    const { notes, tick } = notesAt();
    await notes.noteCopied({ text: 'Seven Shores Cafe', origin: 'https://www.reddit.com', tabId: 3 });
    tick(30_000);
    await notes.noteCopied({ text: '  seven shores cafe  ', origin: 'https://discord.com', tabId: 4 });

    const lines = await notes.top({ tabId: 9 });
    expect(lines).toHaveLength(1);
    // The newest copy wins, so the line names where it was copied this time.
    expect(lines[0]).toBe('copied just now on discord.com: "seven shores cafe"');
  });

  it('is never longer than a selection, and never secret', async () => {
    const { notes } = notesAt();
    const long = 'x'.repeat(NOTES_LIMITS.clipboardChars + 500);
    const note = await notes.noteCopied({ text: long, origin: 'https://www.reddit.com' });
    expect(note?.text).toHaveLength(NOTES_LIMITS.clipboardChars);

    expect(await notes.noteCopied({ text: '4539 1488 0343 6467', origin: 'https://www.reddit.com' })).toBeNull();
    expect(await notes.noteCopied({ text: '   ', origin: 'https://www.reddit.com' })).toBeNull();
  });

  it('outranks everything for ten minutes, then queues like any other note', async () => {
    const { notes, tick } = notesAt();
    await notes.noteCopied({ text: 'Seven Shores Cafe', origin: 'https://www.reddit.com', tabId: 3 });
    tick(60_000);
    await notes.distilNow(pageItem());

    const early = await notes.top({ tabId: 9 });
    expect(early[0]).toContain('copied');

    tick(NOTES_LIMITS.clipboardTopMs);
    const later = await notes.top({ tabId: 9 });
    expect(later[0]).not.toContain('copied');
    expect(later[1]).toContain('copied');
  });

  it('survives a fresh reading of the page it was copied on', async () => {
    const { notes } = notesAt();
    await notes.noteCopied({ text: 'order NW-55821', origin: 'https://discord.com', tabId: 4 });
    await notes.distilNow(pageItem());

    expect((await notes.top({ tabId: 9 })).some((l) => l.includes('order NW-55821'))).toBe(true);
  });

  it('goes when the clipboard setting goes off, and the distilled facts stay', async () => {
    const { notes } = notesAt();
    await notes.noteCopied({ text: 'Seven Shores Cafe', origin: 'https://www.reddit.com', tabId: 3 });
    await notes.distilNow(pageItem());

    await notes.dropCopies();
    const lines = await notes.top({ tabId: 9 });
    expect(lines.some((l) => l.includes('copied'))).toBe(false);
    expect(lines).toHaveLength(1);
    expect(await notes.copies()).toEqual([]);
  });

  it('keeps the copies made in the browser when only the system clipboard is dropped', async () => {
    const { notes } = notesAt();
    await notes.noteCopied({ text: 'Seven Shores Cafe', origin: 'https://www.reddit.com', tabId: 3 });
    await notes.noteCopied({ text: 'from another app', origin: SYSTEM_ORIGIN });

    await notes.dropCopies(SYSTEM_ORIGIN);
    const left = await notes.copies();
    expect(left.map((n) => n.text)).toEqual(['Seven Shores Cafe']);
  });

  it('is not remembered while carat is pinned', async () => {
    const area = new FakeArea();
    const notes = createNotes({ area, pinned: async () => true });
    expect(await notes.noteCopied({ text: 'Seven Shores Cafe', origin: 'https://www.reddit.com' })).toBeNull();
    expect(await notes.copies()).toEqual([]);
  });

  it('goes with everything else on a clear', async () => {
    const session = new FakeArea();
    const store = new ContextStore(session);
    const shots = new ShotStore(session);
    const history = new HistoryStore(session);
    const notes = createNotes({ area: session });
    await notes.noteCopied({ text: 'Seven Shores Cafe', origin: 'https://www.reddit.com', tabId: 3 });
    await notes.flush();
    expect(await notes.copies()).toHaveLength(1);

    await clearAll({ store, shots, history, notes, cache: () => undefined });

    expect(await notes.copies()).toEqual([]);
    expect(await notes.top({ tabId: 3 })).toEqual([]);
    expect(session.data).toEqual({});
  });

  it('is listed in the popup with the clipboard kind', async () => {
    const session = new FakeArea();
    const store = new ContextStore(session);
    const notes = createNotes({ area: session });
    await notes.noteCopied({ text: 'Seven Shores Cafe', origin: 'https://www.reddit.com', tabId: 3 });
    await notes.flush();

    const known = await getKnown(store, undefined, notes);
    expect(known.items).toHaveLength(1);
    expect(known.items[0]?.kind).toBe('clipboard');
    expect(known.items[0]?.preview).toBe('Seven Shores Cafe');
  });
});

describe('the timeline line a copy leaves', () => {
  it('reads "copied" and carries the first 24 characters', async () => {
    const session = new FakeArea();
    const notes = createNotes({ area: session });
    const history = new HistoryStore(session);

    await rememberCopy(
      { text: 'Seven Shores Cafe, 10 Regina St N, Waterloo', origin: 'https://www.reddit.com', tabId: 7 },
      { notes, history },
    );

    expect(await history.lines(7)).toEqual(['just now: copied "Seven Shores Cafe, 10 R…"']);
  });

  it('is left out when there is no tab behind the copy', async () => {
    const session = new FakeArea();
    const notes = createNotes({ area: session });
    const history = new HistoryStore(session);

    await rememberCopy({ text: 'from another app', origin: SYSTEM_ORIGIN }, { notes, history });

    expect(await history.lines(1)).toEqual([]);
    expect(await notes.copies()).toHaveLength(1);
  });
});

function reading(over: Partial<ClipboardReaderDeps> = {}) {
  let clock = 1_000_000;
  let clipboard = 'Seven Shores Cafe';
  const read = vi.fn(async () => clipboard);
  const close = vi.fn(async () => undefined);
  const remember = vi.fn(async () => undefined);
  const deps: ClipboardReaderDeps = {
    settings: async () => ({ enabled: true, clipboardRead: true }),
    granted: async () => true,
    doc: { read, close },
    activeTab: async () => ({ id: 1, url: 'https://www.reddit.com/r/waterloo' }),
    remember,
    now: () => clock,
    ...over,
  };
  return {
    reader: createClipboardReader(deps),
    read,
    close,
    remember,
    tick: (ms: number) => (clock += ms),
    put: (text: string) => (clipboard = text),
  };
}

describe('reading the system clipboard', () => {
  it('stores what it read, under the clipboard host', async () => {
    const { reader, remember } = reading();
    expect(await reader.poll()).toBe('read');
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ text: 'Seven Shores Cafe', origin: SYSTEM_ORIGIN, tabId: 1 }));
  });

  it('does nothing while the setting is off, or the permission is not granted', async () => {
    const off = reading({ settings: async () => ({ enabled: true, clipboardRead: false }) });
    expect(await off.reader.poll()).toBe('off');
    expect(off.read).not.toHaveBeenCalled();

    const ungranted = reading({ granted: async () => false });
    expect(await ungranted.reader.poll()).toBe('no-permission');
    expect(ungranted.read).not.toHaveBeenCalled();
  });

  it('reads at most once every five seconds', async () => {
    const { reader, read, tick, put } = reading();
    expect(await reader.poll()).toBe('read');
    put('Friday at 6');
    expect(await reader.poll()).toBe('too-soon');
    expect(read).toHaveBeenCalledTimes(1);

    tick(CLIPBOARD_TIMING.minGapMs);
    expect(await reader.poll()).toBe('read');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stores nothing when the clipboard has not changed', async () => {
    const { reader, remember, tick } = reading();
    expect(await reader.poll()).toBe('read');
    tick(CLIPBOARD_TIMING.minGapMs);
    expect(await reader.poll()).toBe('unchanged');
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it('never reads over a denylisted host, a password page, or anything that is not a web page', async () => {
    const bank = reading({ activeTab: async () => ({ id: 1, url: 'https://www.chase.com/accounts' }) });
    expect(await bank.reader.poll()).toBe('blocked');
    expect(bank.read).not.toHaveBeenCalled();

    const login = reading({ passwordTab: (id) => id === 1 });
    expect(await login.reader.poll()).toBe('blocked');
    expect(login.read).not.toHaveBeenCalled();

    const settings = reading({ activeTab: async () => ({ id: 1, url: 'chrome://settings' }) });
    expect(await settings.reader.poll()).toBe('blocked');
    expect(settings.read).not.toHaveBeenCalled();

    const none = reading({ activeTab: async () => undefined });
    expect(await none.reader.poll()).toBe('blocked');
  });

  it('throws away a clipboard that reads like a password or a card', async () => {
    const secret = reading();
    secret.put('4539 1488 0343 6467');
    expect(await secret.reader.poll()).toBe('secret');
    expect(secret.remember).not.toHaveBeenCalled();
  });

  it('takes the offscreen document down and forgets the hash when the setting goes off', async () => {
    const { reader, close, remember, tick } = reading();
    expect(await reader.poll()).toBe('read');

    await reader.forget();
    expect(close).toHaveBeenCalledTimes(1);

    tick(CLIPBOARD_TIMING.minGapMs);
    // The same text again: nothing is left to compare it against, so it is stored anew.
    expect(await reader.poll()).toBe('read');
    expect(remember).toHaveBeenCalledTimes(2);
  });
});

describe('the manifest', () => {
  it('asks for the clipboard only as an optional permission', () => {
    const manifest = wxtConfig.manifest as { permissions?: string[]; optional_permissions?: string[] };
    expect(manifest.optional_permissions).toEqual(['clipboardRead']);
    expect(manifest.permissions).not.toContain('clipboardRead');
    // The offscreen document is where the read happens, and it carries no warning.
    expect(manifest.permissions).toContain('offscreen');
  });
});
