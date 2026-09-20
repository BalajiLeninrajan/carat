// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClipboardReader, MIN_GAP_MS, type ClipboardDocument } from '../src/engine/background/clipboard';
import {
  COPY_TOP_MS,
  dropSystemCopies,
  notesFor,
  recordCopied,
  type Note,
} from '../src/engine/background/notes';
import { setClipboardPermission, CLIPBOARD_PERMISSION } from '../entrypoints/options/form';
import { looksSecret } from '../src/engine/shared/redact';
import { DEFAULT_SETTINGS, type Settings } from '../src/engine/shared/settings';

/** chrome.storage.session, as a plain object the tests can read back. */
function sessionStore() {
  let data: Record<string, unknown> = {};
  return {
    api: {
      get: vi.fn(async (key: string) => ({ [key]: data[key] })),
      set: vi.fn(async (patch: Record<string, unknown>) => {
        data = { ...data, ...patch };
      }),
      remove: vi.fn(async (key: string) => {
        delete data[key];
      }),
    },
    notes: () => (data.notes as Note[] | undefined) ?? [],
  };
}

const settings: Settings = { ...DEFAULT_SETTINGS, enabled: true, apiKey: 'sk-x', clipboardRead: true };

let store: ReturnType<typeof sessionStore>;

beforeEach(() => {
  store = sessionStore();
  vi.stubGlobal('chrome', { storage: { session: store.api } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a copy as a note', () => {
  it('stores what was copied, with the page it came from', async () => {
    const note = await recordCopied({ text: '  Seven  Shores Cafe ', url: 'https://reddit.com/r/x', title: 'r/x' });
    expect(note?.source).toBe('copied');
    expect(note?.text).toBe('Seven Shores Cafe');
    expect(store.notes()).toHaveLength(1);
  });

  it('ignores a copy too short to say anything', async () => {
    expect(await recordCopied({ text: 'a', url: 'https://a.test/', title: '' })).toBeNull();
    expect(store.notes()).toHaveLength(0);
  });

  it('drops text shaped like a secret, whatever field it came from', async () => {
    expect(looksSecret('4111 1111 1111 1111')).toBe(true);
    expect(looksSecret('sk-abcdefghijklmnopqrstuvwx')).toBe(true);
    expect(looksSecret('Tr0ub4dor&3!')).toBe(true);
    expect(looksSecret('Seven Shores Cafe')).toBe(false);
    for (const text of ['4111 1111 1111 1111', 'sk-abcdefghijklmnopqrstuvwx', 'Tr0ub4dor&3!']) {
      expect(await recordCopied({ text, url: 'https://a.test/', title: '' })).toBeNull();
    }
    expect(store.notes()).toHaveLength(0);
  });

  it('keeps one note per distinct text and moves its clock', async () => {
    const first = await recordCopied({ text: 'Seven Shores Cafe', url: 'https://a.test/', title: '', at: 1000 });
    const second = await recordCopied({ text: 'seven shores cafe', url: 'https://b.test/', title: '', at: 5000 });
    expect(store.notes()).toHaveLength(1);
    expect(first?.at).toBe(1000);
    expect(second?.at).toBe(5000);
    expect(store.notes()[0]?.url).toBe('https://b.test/');
  });
});

describe('copies in <notes>', () => {
  it('renders in the engine format, naming the host it was copied on', async () => {
    vi.useFakeTimers();
    await recordCopied({ text: 'Seven Shores Cafe', url: 'https://reddit.com/r/x', title: 'r/x' });
    expect(await notesFor('https://maps.test/', settings)).toBe(
      '- the user copied "Seven Shores Cafe" (just now, on reddit.com)',
    );
  });

  it('says where a copy with no page behind it came from', async () => {
    vi.useFakeTimers();
    await recordCopied({ text: 'NW-55821', url: '', title: '' });
    expect(await notesFor('https://a.test/', settings)).toBe('- the user copied "NW-55821" (just now, from another app)');
  });

  it('puts a fresh copy in front of the read notes, and queues it after ten minutes', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const read: Note[] = Array.from({ length: 10 }, (_, i) => ({
      at: now - 1000 + i,
      source: 'read' as const,
      url: `https://read.test/${i}`,
      title: '',
      text: `fact ${i}`,
    }));
    await store.api.set({ notes: read });
    await recordCopied({ text: 'Seven Shores Cafe', url: 'https://reddit.com/r/x', title: '' });

    const fresh = await notesFor('https://a.test/', { ...settings, memoryEnabled: true });
    expect(fresh.split('\n')[0]).toContain('the user copied "Seven Shores Cafe"');
    expect(fresh.split('\n')).toHaveLength(10);

    vi.setSystemTime(now + COPY_TOP_MS + 1000);
    const later = await notesFor('https://a.test/', { ...settings, memoryEnabled: true });
    expect(later.split('\n')[0]).not.toContain('the user copied');
  });

  it('counts a copy whatever the memory and listening settings say', async () => {
    await recordCopied({ text: 'Seven Shores Cafe', url: 'https://reddit.com/r/x', title: '' });
    const off = { ...settings, memoryEnabled: false, listenEnabled: false };
    expect(await notesFor('https://a.test/', off)).toContain('the user copied');
  });

  it('leaves out what the system clipboard produced once the setting is off', async () => {
    await recordCopied({ text: 'NW-55821', url: '', title: '' });
    await recordCopied({ text: 'Seven Shores Cafe', url: 'https://reddit.com/r/x', title: '' });
    expect(await notesFor('https://a.test/', { ...settings, clipboardRead: false })).not.toContain('NW-55821');

    await dropSystemCopies();
    expect(store.notes()).toHaveLength(1);
    expect(store.notes()[0]?.url).toBe('https://reddit.com/r/x');
  });
});

describe('the system clipboard reader', () => {
  function reader(opts: {
    text?: string | (() => string);
    settings?: Partial<Settings>;
    granted?: boolean;
    tab?: { id?: number; url?: string };
    passwords?: Set<number>;
  }) {
    let at = 100_000;
    const remember = vi.fn(async () => undefined);
    const doc: ClipboardDocument = {
      read: vi.fn(async () => (typeof opts.text === 'function' ? opts.text() : (opts.text ?? ''))),
      close: vi.fn(async () => undefined),
    };
    const r = createClipboardReader({
      settings: async () => ({ ...settings, ...opts.settings }),
      granted: async () => opts.granted ?? true,
      doc,
      activeTab: async () => opts.tab ?? { id: 1, url: 'https://a.test/' },
      passwordTab: (id) => opts.passwords?.has(id) === true,
      remember,
      now: () => at,
    });
    return { r, doc, remember, advance: (ms: number) => (at += ms) };
  }

  it('reads nothing until the setting and the permission are both there', async () => {
    expect(await reader({ settings: { clipboardRead: false } }).r.poll()).toBe('off');
    expect(await reader({ settings: { enabled: false } }).r.poll()).toBe('off');
    expect(await reader({ granted: false }).r.poll()).toBe('no-permission');
  });

  it('never reads over a blocklisted host or a password page', async () => {
    expect(await reader({ tab: { id: 1, url: 'https://accounts.google.com/signin' } }).r.poll()).toBe('blocked');
    expect(await reader({ settings: { blocklist: ['a.test'] } }).r.poll()).toBe('blocked');
    expect(await reader({ tab: { id: 1, url: 'chrome://extensions' } }).r.poll()).toBe('blocked');
    expect(await reader({ passwords: new Set([1]) }).r.poll()).toBe('blocked');
    expect(await reader({ tab: undefined, passwords: new Set() }).r.poll()).not.toBe('blocked');
  });

  it('reads at most once every five seconds', async () => {
    let n = 0;
    const { r, advance } = reader({ text: () => `copy ${n++}` });
    expect(await r.poll()).toBe('read');
    expect(await r.poll()).toBe('too-soon');
    advance(MIN_GAP_MS);
    expect(await r.poll()).toBe('read');
  });

  it('stores the text only when it changed, and keeps nothing but its hash', async () => {
    const { r, remember, advance } = reader({ text: 'Seven Shores Cafe' });
    expect(await r.poll()).toBe('read');
    advance(MIN_GAP_MS);
    expect(await r.poll()).toBe('unchanged');
    expect(remember).toHaveBeenCalledTimes(1);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ text: 'Seven Shores Cafe', url: '' }));
  });

  it('answers empty and secret without storing anything', async () => {
    expect(await reader({ text: '   ' }).r.poll()).toBe('empty');
    const secret = reader({ text: 'sk-abcdefghijklmnopqrstuvwx' });
    expect(await secret.r.poll()).toBe('secret');
    expect(secret.remember).not.toHaveBeenCalled();
  });

  it('takes the document down and forgets the hash when the setting goes off', async () => {
    const { r, doc, advance, remember } = reader({ text: 'Seven Shores Cafe' });
    expect(await r.poll()).toBe('read');
    await r.forget();
    expect(doc.close).toHaveBeenCalled();
    advance(MIN_GAP_MS);
    expect(await r.poll()).toBe('read');
    expect(remember).toHaveBeenCalledTimes(2);
  });
});

describe('the clipboard permission toggle', () => {
  const api = (granted: boolean) => ({
    request: vi.fn(async () => granted),
    remove: vi.fn(async () => true),
  });

  it('asks Chrome for the permission when it goes on', async () => {
    const p = api(true);
    expect(await setClipboardPermission(p, true)).toBe(true);
    expect(p.request).toHaveBeenCalledWith({ permissions: [CLIPBOARD_PERMISSION] });
    expect(p.remove).not.toHaveBeenCalled();
  });

  it('reverts when Chrome refuses', async () => {
    expect(await setClipboardPermission(api(false), true)).toBe(false);
  });

  it('gives the permission back when it goes off', async () => {
    const p = api(true);
    expect(await setClipboardPermission(p, false)).toBe(false);
    expect(p.remove).toHaveBeenCalledWith({ permissions: [CLIPBOARD_PERMISSION] });
    expect(p.request).not.toHaveBeenCalled();
  });

  it('stays off when there is no permissions API, or the call throws', async () => {
    expect(await setClipboardPermission(undefined, true)).toBe(false);
    const broken = {
      request: vi.fn(async () => {
        throw new Error('no gesture');
      }),
      remove: vi.fn(async () => true),
    };
    expect(await setClipboardPermission(broken, true)).toBe(false);
  });
});

describe('the built manifest', () => {
  it('keeps clipboardRead optional and never asks for it up front', async () => {
    const config = (await import('../wxt.config')).default;
    const manifest = config.manifest as {
      permissions: string[];
      optional_permissions: string[];
    };
    expect(manifest.permissions).not.toContain('clipboardRead');
    expect(manifest.optional_permissions).toContain('clipboardRead');
    expect(manifest.permissions).toContain('offscreen');
  });
});
