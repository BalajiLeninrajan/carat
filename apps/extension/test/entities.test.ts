import { describe, expect, it } from 'vitest';
import type { Entity } from '@carat/shared';
import { ContextStore, STORE_LIMITS } from '../src/store';
import { ENTITY_KEY } from '../src/store/limits';
import { EntityStore } from '../src/store/entities';
import type { StorageArea } from '../src/store';

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

const MIN = 60_000;
const place: Entity = { value: 'Seven Shores Cafe', kind: 'place', fieldHints: ['search', 'location'], confidence: 0.9 };

function setup(start = 1_000_000) {
  let clock = start;
  const area = new FakeArea();
  const now = () => clock;
  const store = new ContextStore(area, { now });
  const entities = new EntityStore(area, { now });
  const page = (tabId: number, text: string) => store.upsertPage({ tabId, url: `https://site${tabId}.test/a`, title: `Tab ${tabId}`, text });
  const live = async () => entities.forItems(await store.items(), await store.clock());
  return { area, store, entities, page, live, tick: (ms: number) => (clock += ms) };
}

describe('EntityStore', () => {
  it('keys a list by the item id and hands it back for that item', async () => {
    const { entities, page, live } = setup();
    const item = (await page(1, 'dinner at Seven Shores Cafe, Friday at 6?'))!;
    await entities.set(item, [place], 'model');
    expect(await live()).toEqual(new Map([[item.id, [place]]]));
    expect(await entities.get(item.id)).toMatchObject({ hash: item.hash, tabId: 1, source: 'model' });
  });

  it('follows the item\'s TTL: gone when the item expires, kept while re-captures keep it alive', async () => {
    const { area, entities, page, live, store, tick } = setup();
    const item = (await page(1, 'dinner at Seven Shores Cafe, Friday at 6?'))!;
    await entities.set(item, [place], 'model');

    tick(20 * MIN);
    await page(1, 'dinner at Seven Shores Cafe, Friday at 6?'); // same hash: lastSeenAt bumps, id stays
    tick(20 * MIN);
    expect((await live()).get(item.id)).toEqual([place]);

    tick(STORE_LIMITS.itemTtlMs);
    await store.sweep();
    expect(await store.items()).toEqual([]);
    expect(await live()).toEqual(new Map());
    expect(ENTITY_KEY in area.data).toBe(false);
  });

  it('drops a list once its item is replaced by a new hash on the same tab, and never outlives a cleared store', async () => {
    const { entities, page, live, store } = setup();
    const first = (await page(1, 'first text of the page'))!;
    await entities.set(first, [place], 'model');
    const second = (await page(1, 'different text now'))!;
    expect(second.id).not.toBe(first.id);
    expect(await live()).toEqual(new Map());
    expect(await entities.get(first.id)).toBeUndefined();

    await entities.set(second, [place], 'regex');
    await store.clear();
    await entities.sweep(await store.items());
    expect(await entities.get(second.id)).toBeUndefined();
  });

  it('accepts a write for an item a pinned store already holds, and measures freshness on the pinned clock', async () => {
    const { entities, page, live, store, tick } = setup();
    const item = (await page(1, 'dinner at Seven Shores Cafe, Friday at 6?'))!;
    await store.pin();
    await entities.set(item, [place], 'model');
    expect((await live()).get(item.id)).toEqual([place]);
    tick(2 * STORE_LIMITS.itemTtlMs);
    expect((await live()).get(item.id)).toEqual([place]);
    expect(await page(2, 'nothing lands while pinned')).toBeUndefined();
  });

  it('caps a list at the per-item limit and keeps entries under one session key apart from the context store\'s', async () => {
    const { area, entities, page, store } = setup();
    const item = (await page(1, 'some text'))!;
    const many = Array.from({ length: STORE_LIMITS.maxEntitiesPerItem + 5 }, (_, i) => ({ ...place, value: `Place ${i}` }));
    await entities.set(item, many, 'model');
    await store.flush();
    expect((await entities.get(item.id))!.entities).toHaveLength(STORE_LIMITS.maxEntitiesPerItem);
    expect(Object.keys(area.data)).toContain(ENTITY_KEY);
    expect(Array.isArray(area.data.ctx)).toBe(true);
    await entities.clear();
    expect(ENTITY_KEY in area.data).toBe(false);
  });
});
