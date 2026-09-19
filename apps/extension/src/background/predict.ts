import type { ContextItem, Entity, Settings } from '@carat/shared';
import type { Predictor } from '@carat/providers';
import { PREDICT_TIMEOUT_MS, candidatesFrom, createEntityPredictor, entitiesFromCandidates } from '@carat/providers';
import type { ContextStore } from '../store';
import type { EntityStore } from '../store/entities';
import { isoWithOffset } from './vision';

/**
 * What became of one capture. `model`: the chat model answered. `regex`: no
 * key, or the model failed, so the regex list stands in. `reused`: the same
 * text was already predicted on this tab. `dropped`: the item was gone from
 * the store by the time the answer came.
 */
export type PredictOutcome = 'model' | 'regex' | 'reused' | 'dropped';

export interface PredictDeps {
  store: ContextStore;
  entities: EntityStore;
  settings: () => Promise<Settings>;
  createPredictor?: (settings: Settings) => Predictor | undefined;
  /** Budget for one model call. */
  timeoutMs?: number;
  /** Quiet time on a tab before its latest capture is predicted; a chattering page pays once. */
  debounceMs?: number;
  now?: () => number;
  onOutcome?: (tabId: number, outcome: PredictOutcome) => void;
}

export interface PredictPipeline {
  /** Called with the item `upsertPage`, `upsertSelection` or `upsertVision` returned. Never throws, never awaited. */
  onCapture(item: ContextItem): void;
  /** Resolves once every debounce and model call started so far has landed. */
  settled(): Promise<void>;
  /** Drop entity lists whose item the context store no longer holds. */
  sweep(): Promise<void>;
}

export const PREDICT_DEBOUNCE_MS = 1500;
const MEMO_SIZE = 64;

/**
 * Predict at capture time. Each capture is debounced per tab and kind, so a
 * chat page that re-renders every second costs one call after it settles,
 * not one per mutation. One prediction per (tab, hash): a repeat of text
 * already predicted on that tab reuses the list without a call. A model
 * failure falls back to the regex list and is never remembered, so the next
 * capture of the same text asks again. The list is written under the item's
 * id and lives as long as the item does.
 */
export function createPredictPipeline(deps: PredictDeps): PredictPipeline {
  const timeoutMs = deps.timeoutMs ?? PREDICT_TIMEOUT_MS;
  const debounceMs = deps.debounceMs ?? PREDICT_DEBOUNCE_MS;
  const now = deps.now ?? (() => Date.now());
  const create = deps.createPredictor ?? createEntityPredictor;
  /** (tab, hash) -> the model's list; only real answers go in. */
  const memo = new Map<string, Entity[]>();
  const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; done: Promise<void>; finish: () => void }>();
  const inflight = new Map<string, Promise<void>>();

  function onCapture(item: ContextItem): void {
    const slot = `${item.tabId}:${item.kind}`;
    const prev = waiting.get(slot);
    if (prev) {
      clearTimeout(prev.timer);
      prev.finish();
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const timer = setTimeout(() => {
      waiting.delete(slot);
      run(item).catch(() => undefined).finally(finish);
    }, debounceMs);
    waiting.set(slot, { timer, done, finish });
  }

  async function run(item: ContextItem): Promise<void> {
    const key = `${item.tabId}:${item.hash}`;
    const note = (outcome: PredictOutcome): void => deps.onOutcome?.(item.tabId, outcome);
    const existing = await deps.entities.get(item.id);
    if (existing && existing.hash === item.hash && existing.source === 'model') return note('reused');
    const remembered = memo.get(key);
    if (remembered) {
      await write(item, remembered, 'model');
      return note('reused');
    }
    const running = inflight.get(key);
    if (running) return running;
    const job = predict(item, key, note).finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function predict(item: ContextItem, key: string, note: (o: PredictOutcome) => void): Promise<void> {
    const settings = await deps.settings();
    let predictor: Predictor | undefined;
    try {
      predictor = create(settings);
    } catch {
      predictor = undefined;
    }
    let entities: Entity[] | undefined;
    if (predictor) {
      try {
        entities = await predictor.predict(
          { origin: item.origin, title: item.title, kind: item.kind, text: item.text, now: isoWithOffset(now()) },
          { signal: AbortSignal.timeout(timeoutMs) },
        );
        remember(key, entities);
      } catch {
        entities = undefined; // a failed outcome is never cached: the regex list stands in and the next capture asks again
      }
    }
    if (entities) {
      note((await write(item, entities, 'model')) ? 'model' : 'dropped');
    } else {
      note((await write(item, entitiesFromCandidates(candidatesFrom(item)), 'regex')) ? 'regex' : 'dropped');
    }
  }

  /** Writes only if the store still holds the item; an entity list never outlives its item. */
  async function write(item: ContextItem, entities: Entity[], source: 'model' | 'regex'): Promise<boolean> {
    const held = (await deps.store.items()).some((i) => i.id === item.id);
    if (!held) return false;
    await deps.entities.set(item, entities, source);
    return true;
  }

  function remember(key: string, entities: Entity[]): void {
    memo.delete(key);
    memo.set(key, entities);
    if (memo.size > MEMO_SIZE) memo.delete(memo.keys().next().value!);
  }

  async function settled(): Promise<void> {
    while (waiting.size > 0 || inflight.size > 0) {
      await Promise.all([...[...waiting.values()].map((w) => w.done), ...inflight.values()]);
    }
  }

  async function sweep(): Promise<void> {
    await deps.entities.sweep(await deps.store.items(), await deps.store.clock());
  }

  return { onCapture, settled, sweep };
}
