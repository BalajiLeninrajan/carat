import type { ContextItem, Entity } from '@carat/shared';
import { ENTITY_KEY, STORE_LIMITS } from './limits';
import type { StorageArea } from './storage-area';

/** Where a list came from. A regex list stands in for a model answer that never came, so it is retried, never reused. */
export type EntitySourceKind = 'model' | 'regex';

export interface EntityEntry {
  entities: Entity[];
  /** The item's text hash when predicted; a repeat capture with the same hash reuses the list. */
  hash: number;
  tabId: number;
  source: EntitySourceKind;
  at: number;
}

type EntityMap = Record<string, EntityEntry>;

/**
 * Predicted entities per context item, under one session key beside the
 * context store. An entry is keyed by the item's id and lives exactly as
 * long as the item: every read is given the store's live items and drops
 * whatever they no longer include, and the sweep does the same on the alarm.
 * Nothing here reaches chrome.storage.local. Writes are accepted regardless
 * of the pin, since a pinned store still holds the items they belong to.
 */
export class EntityStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly area: StorageArea,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  set(item: Pick<ContextItem, 'id' | 'hash' | 'tabId'>, entities: Entity[], source: EntitySourceKind): Promise<void> {
    return this.run((map) => ({
      ...map,
      [item.id]: { entities: entities.slice(0, STORE_LIMITS.maxEntitiesPerItem), hash: item.hash, tabId: item.tabId, source, at: this.now() },
    }));
  }

  async get(id: string): Promise<EntityEntry | undefined> {
    let out: EntityEntry | undefined;
    await this.run((map) => {
      out = map[id];
      return map;
    });
    return out;
  }

  /**
   * The lists for these items, by id, dropping every entry whose item is gone
   * or past its TTL. `now` is the store's clock, which stands still while pinned.
   */
  async forItems(items: readonly ContextItem[], now: number = this.now()): Promise<Map<string, Entity[]>> {
    const out = new Map<string, Entity[]>();
    await this.run((map) => {
      const kept = prune(map, items, now);
      for (const item of items) {
        const entry = kept[item.id];
        if (entry) out.set(item.id, entry.entities);
      }
      return kept;
    });
    return out;
  }

  /** Drop entries whose item the context store no longer holds. Cheap; runs on the alarm. */
  sweep(items: readonly ContextItem[], now: number = this.now()): Promise<void> {
    return this.run((map) => prune(map, items, now));
  }

  clear(): Promise<void> {
    const step = this.chain.then(() => this.area.remove([ENTITY_KEY]));
    this.chain = step.catch(() => undefined);
    return step;
  }

  private run(fn: (map: EntityMap) => EntityMap): Promise<void> {
    const step = this.chain.then(async () => {
      const raw = (await this.area.get([ENTITY_KEY]))[ENTITY_KEY];
      const before = asMap(raw);
      const next = fn(before);
      if (next === before) return;
      if (Object.keys(next).length === 0) await this.area.remove([ENTITY_KEY]);
      else await this.area.set({ [ENTITY_KEY]: next });
    });
    this.chain = step.catch(() => undefined);
    return step;
  }
}

function prune(map: EntityMap, items: readonly ContextItem[], now: number): EntityMap {
  const live = new Set(items.filter((i) => now - i.lastSeenAt < STORE_LIMITS.itemTtlMs).map((i) => i.id));
  const ids = Object.keys(map);
  if (ids.every((id) => live.has(id))) return map;
  return Object.fromEntries(ids.filter((id) => live.has(id)).map((id) => [id, map[id]!]));
}

function asMap(v: unknown): EntityMap {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as EntityMap) : {};
}
