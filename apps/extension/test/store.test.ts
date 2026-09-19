import { describe, expect, it } from 'vitest';
import { ContextStore, STORE_LIMITS, ShotStore, createSettingsStore, isSiteOff, siteHost, withSite } from '../src/store';
import type { StorageArea } from '../src/store';

class FakeArea implements StorageArea {
  data: Record<string, unknown> = {};
  writes = 0;
  async get(keys: string[]) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>) {
    this.writes++;
    Object.assign(this.data, structuredClone(items));
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k];
  }
}

const MIN = 60_000;

function setup(start = 1_000_000) {
  let clock = start;
  const area = new FakeArea();
  const store = new ContextStore(area, { now: () => clock });
  return { area, store, tick: (ms: number) => (clock += ms) };
}

const page = (tabId: number, text: string, url = `https://site${tabId}.test/a?x=1#y`) => ({
  tabId,
  url,
  title: `Tab ${tabId}`,
  text,
});

describe('ContextStore pages', () => {
  it('keeps one page item per tab and replaces on a new hash', async () => {
    const { store } = setup();
    const first = await store.upsertPage(page(1, 'first text of the page'));
    const second = await store.upsertPage(page(1, 'different text now'));
    const items = await store.items();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(second?.id);
    expect(items[0]?.id).not.toBe(first?.id);
  });

  it('bumps lastSeenAt on the same hash without a new id', async () => {
    const { store, tick } = setup();
    const first = await store.upsertPage(page(1, 'same  text'));
    tick(5 * MIN);
    const again = await store.upsertPage(page(1, 'same text'));
    const items = await store.items();
    expect(items).toHaveLength(1);
    expect(again?.id).toBe(first?.id);
    expect(items[0]?.capturedAt).toBe(first?.capturedAt);
    expect(items[0]?.lastSeenAt).toBe(first!.capturedAt + 5 * MIN);
  });

  it('strips query and hash and rejects non-http urls', async () => {
    const { store } = setup();
    const item = await store.upsertPage(page(1, 'hello there world'));
    expect(item?.origin).toBe('https://site1.test');
    expect(item?.path).toBe('/a');
    expect(await store.upsertPage(page(2, 'hello', 'chrome://extensions'))).toBeUndefined();
  });

  it('writes through to the storage area and loads back', async () => {
    const { area, store } = setup();
    await store.upsertPage(page(1, 'persisted text'));
    await store.flush();
    expect(Array.isArray(area.data.ctx)).toBe(true);
    const reloaded = new ContextStore(area);
    const items = await reloaded.items();
    expect(items[0]?.text).toBe('persisted text');
  });
});

describe('ContextStore selections and caps', () => {
  it('keeps at most 5 selections, evicting least recently seen', async () => {
    const { store, tick } = setup();
    for (let i = 0; i < 7; i++) {
      await store.upsertSelection(page(1, `selection number ${i}`));
      tick(1000);
    }
    const sel = (await store.items()).filter((i) => i.kind === 'selection');
    expect(sel).toHaveLength(STORE_LIMITS.maxSelections);
    expect(sel.map((s) => s.text)).not.toContain('selection number 0');
    expect(sel.map((s) => s.text)).not.toContain('selection number 1');
  });

  it('dedupes a repeated selection from the same tab', async () => {
    const { store } = setup();
    await store.upsertSelection(page(1, 'quoted bit'));
    await store.upsertSelection(page(1, 'quoted bit'));
    expect(await store.items()).toHaveLength(1);
  });

  it('caps total items at 20', async () => {
    const { store, tick } = setup();
    for (let t = 0; t < 25; t++) {
      await store.upsertPage(page(t, `page for tab ${t}`));
      tick(1000);
    }
    const items = await store.items();
    expect(items).toHaveLength(STORE_LIMITS.maxItems);
    expect(items.map((i) => i.tabId)).not.toContain(0);
    expect(items.map((i) => i.tabId)).toContain(24);
  });

  it('caps total size at 64KB', async () => {
    const { store, tick } = setup();
    const big = 'x'.repeat(3900);
    for (let t = 0; t < 20; t++) {
      await store.upsertPage(page(t, `${t} ${big}`));
      tick(1000);
    }
    const items = await store.items();
    expect(items.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(items)).length).toBeLessThanOrEqual(STORE_LIMITS.maxBytes);
    expect(items.map((i) => i.tabId)).toContain(19);
  });
});

describe('ContextStore TTL', () => {
  it('evicts items older than 30 minutes on sweep', async () => {
    const { store, tick } = setup();
    await store.upsertPage(page(1, 'old page text'));
    tick(31 * MIN);
    await store.sweep();
    expect(await store.items()).toHaveLength(0);
  });

  it('evicts expired items on the next write', async () => {
    const { store, tick } = setup();
    await store.upsertPage(page(1, 'old page text'));
    tick(31 * MIN);
    await store.upsertPage(page(2, 'fresh page text'));
    expect((await store.items()).map((i) => i.tabId)).toEqual([2]);
  });

  it('expires consumed after 30 min and dismissed after 10 min', async () => {
    const { store, tick } = setup();
    await store.markConsumed('c1:host:fp');
    await store.markDismissed('c2:host:fp');
    expect(await store.suppressedKeys()).toEqual(['c1:host:fp', 'c2:host:fp']);
    tick(11 * MIN);
    expect(await store.suppressedKeys()).toEqual(['c1:host:fp']);
    tick(20 * MIN);
    expect(await store.suppressedKeys()).toEqual([]);
  });

  it('expires the suggestion cache after 60s', async () => {
    const { store, tick } = setup();
    const s = [{ kind: 'fill' as const, fieldId: 'f0', value: 'v', confidence: 0.9, reason: 'r', sourceContextId: 'c' }];
    await store.setCached('k', s);
    expect(await store.getCached('k')).toEqual(s);
    tick(61_000);
    expect(await store.getCached('k')).toBeUndefined();
  });

  it('clear wipes everything from memory and storage', async () => {
    const { area, store } = setup();
    await store.upsertPage(page(1, 'some text here'));
    await store.markConsumed('k');
    await store.setCached('c', []);
    await store.clear();
    expect(await store.items()).toEqual([]);
    expect(await store.suppressedKeys()).toEqual([]);
    expect(area.data).toEqual({});
  });
});

describe('ContextStore pin', () => {
  it('blocks new captures and stops the clock while pinned', async () => {
    const { store, tick } = setup();
    await store.upsertPage(page(1, 'kept for the demo'));
    await store.markDismissed('d:host:fp');
    await store.pin();
    expect(await store.isPinned()).toBe(true);
    expect(await store.upsertPage(page(2, 'a stray tab'))).toBeUndefined();
    expect(await store.upsertSelection(page(2, 'stray selection'))).toBeUndefined();

    tick(45 * MIN);
    await store.sweep();
    expect((await store.items()).map((i) => i.tabId)).toEqual([1]);
    expect(await store.suppressedKeys()).toEqual(['d:host:fp']);
    expect(await store.clock()).toBe(1_000_000);
  });

  it('unpin lets real time back in and evicts what expired meanwhile', async () => {
    const { store, tick } = setup();
    await store.upsertPage(page(1, 'kept for the demo'));
    await store.pin();
    tick(45 * MIN);
    await store.unpin();
    expect(await store.isPinned()).toBe(false);
    expect(await store.items()).toEqual([]);
    expect(await store.upsertPage(page(2, 'captures again'))).toBeDefined();
  });

  it('persists the pin across a reload and drops it on clear', async () => {
    const { area, store } = setup();
    await store.pin();
    await store.flush();
    expect(await new ContextStore(area).isPinned()).toBe(true);
    await store.clear();
    expect(await store.isPinned()).toBe(false);
    expect(await new ContextStore(area).isPinned()).toBe(false);
  });
});

describe('ContextStore resilience', () => {
  it('retries load after a failed read instead of staying broken', async () => {
    const area = new FakeArea();
    let fail = true;
    const get = area.get.bind(area);
    area.get = async (keys) => {
      if (fail) throw new Error('storage unavailable');
      return get(keys);
    };
    area.data.ctx = [{ ...page(1, 'kept text'), id: 'k', origin: 'https://site1.test', path: '/', kind: 'page', hash: 1, capturedAt: 1, lastSeenAt: 1 }];
    const store = new ContextStore(area, { now: () => 2 });
    await expect(store.items()).rejects.toThrow('storage unavailable');
    fail = false;
    expect((await store.items()).map((i) => i.id)).toEqual(['k']);
  });

  it('prunes expired entries on every write, not only on sweep', async () => {
    const { area, store, tick } = setup();
    await store.upsertPage(page(1, 'old page text'));
    await store.markDismissed('d:host:fp');
    tick(31 * MIN);
    await store.markConsumed('c:host:fp');
    await store.flush();
    expect(area.data.ctx).toEqual([]);
    expect(area.data.dismissed).toEqual({});
    expect(Object.keys(area.data.consumed as object)).toEqual(['c:host:fp']);
  });

  it('keeps writing after a failed clear', async () => {
    const { area, store } = setup();
    const remove = area.remove.bind(area);
    area.remove = async () => {
      throw new Error('nope');
    };
    await expect(store.clear()).rejects.toThrow('nope');
    area.remove = remove;
    await store.upsertPage(page(1, 'after the failure'));
    await store.flush();
    expect((area.data.ctx as unknown[]).length).toBe(1);
  });
});

describe('settings store', () => {
  it('returns defaults when nothing is stored', async () => {
    const settings = createSettingsStore(new FakeArea());
    expect(await settings.get()).toEqual({
      enabled: true,
      provider: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-5.6-luna',
      cfAccountId: '',
      cfApiToken: '',
      disabledHosts: [],
      statusLine: false,
      screenshots: false,
      smartModel: '',
    });
  });

  it('keeps screenshots off unless stored as true and keeps a blank smart model blank', async () => {
    const settings = createSettingsStore(new FakeArea());
    const next = await settings.set({ screenshots: 'yes' as never, smartModel: '  ' });
    expect(next.screenshots).toBe(false);
    expect(next.smartModel).toBe('');
    expect((await settings.set({ screenshots: true, smartModel: ' big ' })).screenshots).toBe(true);
    expect((await settings.get()).smartModel).toBe('big');
  });

  it('carries a stored visionModel over to smartModel until the user sets one, except the old default', async () => {
    const area = new FakeArea();
    area.data['settings'] = { visionModel: 'old-big', screenshots: true };
    const settings = createSettingsStore(area);
    expect((await settings.get()).smartModel).toBe('old-big');
    // Every save used to write 'gpt-5.6' back, so that value means "never chose one", which is now blank.
    area.data['settings'] = { visionModel: 'gpt-5.6' };
    expect((await settings.get()).smartModel).toBe('');
    // A saved smartModel wins, and the old key stops mattering once it has been written over.
    area.data['settings'] = { visionModel: 'old-big', smartModel: 'new-big' };
    expect((await settings.get()).smartModel).toBe('new-big');
    const next = await settings.set({ apiKey: 'sk-1' });
    expect(next.smartModel).toBe('new-big');
    expect(area.data['settings']).not.toHaveProperty('visionModel');
  });

  it('merges patches and drops unknown values', async () => {
    const area = new FakeArea();
    const settings = createSettingsStore(area);
    const next = await settings.set({ apiKey: ' sk-1 ', provider: 'nope' as never, baseURL: 'https://x.test/v1/', cfApiToken: ' cf-1 ' });
    expect(next.apiKey).toBe('sk-1');
    expect(next.cfApiToken).toBe('cf-1');
    expect(next.provider).toBe('openai');
    expect(next.baseURL).toBe('https://x.test/v1');
    expect(await settings.get()).toEqual(next);
    expect((await settings.set({ provider: 'cloudflare' })).provider).toBe('cloudflare');
  });

  it('keeps disabled hosts lowercased, deduped and free of junk', async () => {
    const settings = createSettingsStore(new FakeArea());
    const next = await settings.set({ disabledHosts: [' Discord.com ', 'discord.com', '', 3, 'maps.google.com:8443'] as never });
    expect(next.disabledHosts).toEqual(['discord.com', 'maps.google.com:8443']);
    expect((await settings.set({ disabledHosts: 'nope' as never })).disabledHosts).toEqual([]);
  });
});

describe('per-site switch', () => {
  it('matches hosts exactly, so one google host does not switch off another', () => {
    const s = { disabledHosts: ['www.google.com'] };
    expect(isSiteOff(s, 'www.google.com')).toBe(true);
    expect(isSiteOff(s, 'WWW.google.com')).toBe(true);
    expect(isSiteOff(s, 'calendar.google.com')).toBe(false);
    expect(isSiteOff(s, 'google.com')).toBe(false);
  });

  it('toggles one host without touching the rest', () => {
    const s = { disabledHosts: ['a.test'] };
    expect(withSite(s, 'B.test', false)).toEqual({ disabledHosts: ['a.test', 'b.test'] });
    expect(withSite(s, 'a.test', true)).toEqual({ disabledHosts: [] });
    expect(withSite(s, 'a.test', false)).toEqual({ disabledHosts: ['a.test'] });
  });

  it('only names hosts carat could run on', () => {
    expect(siteHost('https://calendar.google.com/calendar/u/0/r?x=1')).toBe('calendar.google.com');
    expect(siteHost('http://localhost:5173/')).toBe('localhost:5173');
    expect(siteHost('chrome://extensions')).toBeUndefined();
    expect(siteHost('file:///tmp/a.html')).toBeUndefined();
    expect(siteHost(undefined)).toBeUndefined();
    expect(siteHost('not a url')).toBeUndefined();
  });
});

describe('ContextStore recent fills', () => {
  it('remembers fill sources per tab for a minute, newest first and deduped', async () => {
    const { store, tick } = setup();
    await store.markFilled(1, 'c1');
    await store.markFilled(1, 'c2');
    await store.markFilled(1, 'c1');
    await store.markFilled(2, 'c9');
    expect(await store.recentFillSources(1)).toEqual(['c1', 'c2']);
    expect(await store.recentFillSources(2)).toEqual(['c9']);
    expect(await store.recentFillSources(3)).toEqual([]);
    tick(10 * 1000);
    await store.markFilled(1, 'c3');
    tick(STORE_LIMITS.filledTtlMs - 5 * 1000);
    expect(await store.recentFillSources(1)).toEqual(['c3']);
    tick(10 * 1000);
    expect(await store.recentFillSources(1)).toEqual([]);
  });

  it('survives a reload of the mirror and is swept with everything else', async () => {
    const { area, store, tick } = setup();
    await store.markFilled(1, 'c1');
    await store.flush();
    const again = new ContextStore(area, { now: () => 1_000_000 + 1000 });
    expect(await again.recentFillSources(1)).toEqual(['c1']);
    tick(2 * STORE_LIMITS.filledTtlMs);
    await store.sweep();
    await store.flush();
    expect(area.data.filled).toEqual({});
  });
});

describe('ContextStore vision items', () => {
  it('keeps one vision item per tab, apart from the page item of the same tab', async () => {
    const { store } = setup();
    await store.upsertPage(page(1, 'page text of tab one'));
    const first = await store.upsertVision(page(1, 'read off a screenshot'));
    const second = await store.upsertVision(page(1, 'read off a newer screenshot'));
    const items = await store.items();
    expect(items.map((i) => i.kind).sort()).toEqual(['page', 'vision']);
    expect(items.find((i) => i.kind === 'vision')?.id).toBe(second?.id);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.id.startsWith('v')).toBe(true);
  });

  it('caps vision text like a page and expires it like everything else', async () => {
    const { store, tick } = setup();
    const item = await store.upsertVision(page(1, 'v'.repeat(5000)));
    expect(item?.text.length).toBe(4000);
    tick(31 * MIN);
    await store.sweep();
    expect(await store.items()).toEqual([]);
  });
});

describe('ShotStore', () => {
  const shot = (tabId: number) => ({
    tabId,
    url: `https://site${tabId}.test/p?q=1`,
    title: `Tab ${tabId}`,
    dataUrl: `data:image/jpeg;base64,${tabId}`,
    cue: 'thin-text' as const,
  });
  function shots(start = 1_000_000) {
    let clock = start;
    const area = new FakeArea();
    return { area, shots: new ShotStore(area, { now: () => clock }), tick: (ms: number) => (clock += ms) };
  }

  it('keeps one shot per tab and at most two, dropping the oldest', async () => {
    const { shots: s, tick } = shots();
    await s.put(shot(1));
    tick(1000);
    await s.put(shot(2));
    tick(1000);
    await s.put(shot(1));
    expect((await s.live()).map((x) => x.tabId)).toEqual([2, 1]);
    tick(1000);
    await s.put(shot(3));
    expect((await s.live()).map((x) => x.tabId)).toEqual([1, 3]);
    expect(STORE_LIMITS.maxShots).toBe(2);
  });

  it('take hands a shot out once and removes it', async () => {
    const { shots: s, area } = shots();
    await s.put(shot(1));
    expect((await s.take(1))?.dataUrl).toBe('data:image/jpeg;base64,1');
    expect(await s.take(1)).toBeUndefined();
    expect(area.data.shots).toBeUndefined();
  });

  it('forgets a shot after three minutes even without a sweep', async () => {
    const { shots: s, area, tick } = shots();
    await s.put(shot(1));
    tick(STORE_LIMITS.shotTtlMs + 1);
    expect(await s.take(1)).toBeUndefined();
    await s.put(shot(2));
    tick(STORE_LIMITS.shotTtlMs + 1);
    await s.sweep();
    expect(area.data.shots).toBeUndefined();
  });

  it('remove drops one tab and clear drops the key', async () => {
    const { shots: s, area } = shots();
    await s.put(shot(1));
    await s.put(shot(2));
    await s.remove(1);
    expect((await s.live()).map((x) => x.tabId)).toEqual([2]);
    await s.clear();
    expect(area.data).toEqual({});
  });

  it('lives under its own key so a fresh instance and the context store do not see each other', async () => {
    const { shots: s, area } = shots();
    await s.put(shot(1));
    expect(Object.keys(area.data)).toEqual(['shots']);
    expect((await new ShotStore(area, { now: () => 1_000_000 }).live()).map((x) => x.tabId)).toEqual([1]);
    expect(await new ContextStore(area).items()).toEqual([]);
  });
});
