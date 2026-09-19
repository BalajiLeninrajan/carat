import type { NextAction } from '@carat/shared';
import type { StorageArea } from '../store';

/** Session key for the answer cache, beside the timeline and the open tickets. */
export const ANSWER_KEY = 'answerCache';

/** How long an answer stands for a page whose outline and history have not moved. */
export const CACHE_MS = 60_000;

/**
 * An answer is a control number, a kind, a short label and a reason, so an
 * entry is a couple of hundred bytes and sixty seconds is all any of them
 * live. The cap is what keeps a tab that is asking every half second from
 * writing an unbounded object back to storage.
 */
const MAX_ENTRIES = 40;

export interface CacheEntry {
  at: number;
  action: NextAction | null;
}

/**
 * The 60 s answer cache, mirrored into `chrome.storage.session`. The worker's
 * own Map answers every read; the copy in storage is there for the next
 * worker, which would otherwise have to ask the model again for a page it has
 * already paid for. Without an area it is memory only, which is what the
 * tests and the no-storage paths get.
 */
export class AnswerCache {
  private entries = new Map<string, CacheEntry>();
  private area: StorageArea | undefined;
  private loaded: Promise<void> | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  /** Back the cache with a storage area. Called once, at worker start. */
  attach(area: StorageArea): void {
    this.area = area;
    this.loaded = undefined;
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    await this.load();
    return this.entries.get(key);
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await this.load();
    this.entries.set(key, entry);
    this.prune();
    this.write();
  }

  /**
   * Synchronous by design: a clear must leave no answer standing behind the
   * stores it was built from, and the copy in storage follows right after.
   */
  clear(): void {
    this.entries.clear();
    // Nothing to read back: this worker's Map is now the whole truth.
    this.loaded = Promise.resolve();
    const area = this.area;
    if (area) this.chain = this.chain.then(() => area.remove([ANSWER_KEY])).catch(() => undefined);
  }

  /** Resolves once every queued write has reached the storage area. */
  flush(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  private load(): Promise<void> {
    if (!this.loaded) {
      const area = this.area;
      this.loaded = area
        ? area
            .get([ANSWER_KEY])
            .then((raw) => {
              for (const [key, entry] of Object.entries(asEntries(raw[ANSWER_KEY]))) {
                if (!this.entries.has(key)) this.entries.set(key, entry);
              }
            })
            .catch(() => undefined)
        : Promise.resolve();
    }
    return this.loaded;
  }

  /** Past the TTL, or past the cap: gone. The newest write is the clock, so no timer is needed. */
  private prune(): void {
    const newest = Math.max(...[...this.entries.values()].map((e) => e.at));
    for (const [key, entry] of this.entries) if (newest - entry.at >= CACHE_MS) this.entries.delete(key);
    for (const key of [...this.entries.keys()].slice(0, this.entries.size - MAX_ENTRIES)) this.entries.delete(key);
  }

  private write(): void {
    const area = this.area;
    if (!area) return;
    const snapshot = Object.fromEntries(this.entries);
    this.chain = this.chain.then(() => area.set({ [ANSWER_KEY]: snapshot })).catch(() => undefined);
  }
}

function asEntries(v: unknown): Record<string, CacheEntry> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, CacheEntry> = {};
  for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && typeof (entry as CacheEntry).at === 'number') out[key] = entry as CacheEntry;
  }
  return out;
}
