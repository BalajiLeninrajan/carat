import { describe, expect, it, vi } from 'vitest';
import type { Entity, Settings } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
import { candidatesFrom, entitiesFromCandidates } from '@carat/providers';
import { ContextStore } from '../src/store';
import { EntityStore } from '../src/store/entities';
import type { StorageArea } from '../src/store';
import { createPredictPipeline } from '../src/background/predict';
import type { PredictDeps, PredictOutcome } from '../src/background/predict';

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

const keyed: Settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-test' };
const DISCORD = 'Discord #general alex: dinner at Seven Shores Cafe, Friday at 6? sam: sounds good';
const place: Entity = { value: 'Seven Shores Cafe', kind: 'place', fieldHints: ['search', 'location'], confidence: 0.92 };

function setup(over: Partial<PredictDeps> = {}) {
  const area = new FakeArea();
  const store = new ContextStore(area);
  const entities = new EntityStore(area);
  const predict = vi.fn(async () => [place]);
  const outcomes: PredictOutcome[] = [];
  const deps: PredictDeps = {
    store,
    entities,
    settings: async () => keyed,
    createPredictor: () => ({ predict }),
    debounceMs: 5,
    onOutcome: (_tab, o) => outcomes.push(o),
    ...over,
  };
  const pipeline = createPredictPipeline(deps);
  const capture = async (tabId: number, text: string, kind: 'page' | 'selection' = 'page') => {
    const input = { tabId, url: `https://discord.com/channels/${tabId}`, title: 'Discord', text };
    const item = (kind === 'page' ? await store.upsertPage(input) : await store.upsertSelection(input))!;
    pipeline.onCapture(item);
    return item;
  };
  const live = async () => entities.forItems(await store.items());
  return { store, entities, predict, outcomes, pipeline, capture, live };
}

describe('predict pipeline', () => {
  it('asks the model once per (tab, hash) and reuses the list when the text repeats', async () => {
    const { pipeline, predict, capture, live, outcomes } = setup();
    const item = await capture(1, DISCORD);
    await pipeline.settled();
    expect(predict).toHaveBeenCalledTimes(1);
    expect((await live()).get(item.id)).toEqual([place]);
    const [input, opts] = predict.mock.calls[0]! as unknown as [{ text: string; now: string; origin: string }, { signal: AbortSignal }];
    expect(input).toMatchObject({ origin: 'https://discord.com', text: DISCORD });
    expect(input.now).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(opts.signal).toBeInstanceOf(AbortSignal);

    await capture(1, DISCORD); // same hash, same item
    await pipeline.settled();
    expect(predict).toHaveBeenCalledTimes(1);

    const changed = await capture(1, `${DISCORD} priya: in`);
    await pipeline.settled();
    expect(predict).toHaveBeenCalledTimes(2);

    const back = await capture(1, DISCORD); // the earlier hash again: a new item, no new call
    await pipeline.settled();
    expect(predict).toHaveBeenCalledTimes(2);
    expect(back.id).not.toBe(item.id);
    expect((await live()).get(back.id)).toEqual([place]);
    expect((await live()).has(changed.id)).toBe(false);
    expect(outcomes).toEqual(['model', 'reused', 'model', 'reused']);
  });

  it('debounces a chattering tab: three captures in quick succession cost one call, for the last text', async () => {
    const { pipeline, predict, capture, live } = setup({ debounceMs: 20 });
    await capture(1, `${DISCORD} 1`);
    await capture(1, `${DISCORD} 2`);
    const last = await capture(1, `${DISCORD} 3`);
    await pipeline.settled();
    expect(predict).toHaveBeenCalledTimes(1);
    expect((predict.mock.calls[0]! as unknown as [{ text: string }])[0].text).toBe(`${DISCORD} 3`);
    expect((await live()).get(last.id)).toEqual([place]);
  });

  it('predicts a page and a selection on the same tab separately', async () => {
    const { pipeline, predict, capture } = setup();
    await capture(1, DISCORD);
    await capture(1, 'Seven Shores Cafe', 'selection');
    await pipeline.settled();
    expect(predict).toHaveBeenCalledTimes(2);
  });

  it('falls back to the regex candidates when there is no key', async () => {
    const { pipeline, capture, live, outcomes } = setup({ settings: async () => DEFAULT_SETTINGS, createPredictor: undefined });
    const item = await capture(1, DISCORD);
    await pipeline.settled();
    const expected = entitiesFromCandidates(candidatesFrom(item));
    expect(expected.length).toBeGreaterThan(0);
    expect((await live()).get(item.id)).toEqual(expected);
    expect(outcomes).toEqual(['regex']);
  });

  it('falls back to the regex list when the model fails, and asks again on the next capture of the same text', async () => {
    const predict = vi.fn<() => Promise<Entity[]>>().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValueOnce([place]);
    const { pipeline, capture, live, outcomes, entities } = setup({ createPredictor: () => ({ predict }) });
    const item = await capture(1, DISCORD);
    await pipeline.settled();
    expect((await live()).get(item.id)).toEqual(entitiesFromCandidates(candidatesFrom(item)));
    expect((await entities.get(item.id))?.source).toBe('regex');

    await capture(1, DISCORD);
    await pipeline.settled();
    expect(predict).toHaveBeenCalledTimes(2);
    expect((await live()).get(item.id)).toEqual([place]);
    expect(outcomes).toEqual(['regex', 'model']);
  });

  it('aborts a slow model at the budget and stores the regex list instead', async () => {
    const predict = vi.fn((_: unknown, opts: { signal: AbortSignal }) =>
      new Promise<Entity[]>((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))),
    );
    const { pipeline, capture, live, outcomes } = setup({ createPredictor: () => ({ predict }), timeoutMs: 10 });
    const item = await capture(1, DISCORD);
    await pipeline.settled();
    expect((await live()).get(item.id)).toEqual(entitiesFromCandidates(candidatesFrom(item)));
    expect(outcomes).toEqual(['regex']);
  });

  it('writes nothing for an item the store no longer holds', async () => {
    let release!: (v: Entity[]) => void;
    const predict = vi.fn(() => new Promise<Entity[]>((resolve) => (release = resolve)));
    const { pipeline, capture, store, entities } = setup({ createPredictor: () => ({ predict }), debounceMs: 0 });
    const item = await capture(1, DISCORD);
    await new Promise((r) => setTimeout(r, 5));
    await store.clear();
    release([place]);
    await pipeline.settled();
    expect(await entities.get(item.id)).toBeUndefined();
  });

  it('sweep drops lists whose item the store has forgotten', async () => {
    const { pipeline, capture, store, entities } = setup();
    const item = await capture(1, DISCORD);
    await pipeline.settled();
    await store.clear();
    await pipeline.sweep();
    expect(await entities.get(item.id)).toBeUndefined();
  });
});
