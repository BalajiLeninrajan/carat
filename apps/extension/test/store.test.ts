import { describe, expect, it } from 'vitest';
import { ContextStore, STORE_LIMITS, createSettingsStore } from '../src/store';
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
    const s = [{ fieldId: 'f0', value: 'v', confidence: 0.9, reason: 'r', sourceContextId: 'c' }];
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
    });
  });

  it('merges patches and drops unknown values', async () => {
    const area = new FakeArea();
    const settings = createSettingsStore(area);
    const next = await settings.set({ apiKey: ' sk-1 ', provider: 'nope' as never, baseURL: 'https://x.test/v1/' });
    expect(next.apiKey).toBe('sk-1');
    expect(next.provider).toBe('openai');
    expect(next.baseURL).toBe('https://x.test/v1');
    expect(await settings.get()).toEqual(next);
  });
});
