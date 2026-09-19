import type { ContextItem, Suggestion } from '@carat/shared';
import { LIMITS, hashText, normalizeWhitespace, truncate } from '@carat/shared';
import { STORE_KEYS, STORE_LIMITS, type StoreKey } from './limits';
import type { StorageArea } from './storage-area';

export interface CaptureInput {
  tabId: number;
  url: string;
  title: string;
  text: string;
}

interface CacheEntry {
  suggestions: Suggestion[];
  expiresAt: number;
}

/** key -> expiresAt */
type ExpiringSet = Record<string, number>;

interface State {
  ctx: ContextItem[];
  consumed: ExpiringSet;
  dismissed: ExpiringSet;
  cache: Record<string, CacheEntry>;
  /** When the store was pinned, or 0. While pinned its clock stands still. */
  pinned: number;
}

export interface ContextStoreOptions {
  now?: () => number;
}

/**
 * Short-lived context over chrome.storage.session. The in-memory mirror is the
 * source of truth once loaded; every mutation writes the touched keys through.
 * Nothing here ever reaches chrome.storage.local.
 */
export class ContextStore {
  private state: State = emptyState();
  private loading: Promise<void> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private seq = 0;

  constructor(
    private readonly area: StorageArea,
    opts: ContextStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Idempotent; the first call after a service-worker wake reads the mirror back. */
  load(): Promise<void> {
    this.loading ??= this.area
      .get([...STORE_KEYS])
      .then((raw) => {
        this.state = {
          ctx: Array.isArray(raw.ctx) ? (raw.ctx as ContextItem[]) : [],
          consumed: asRecord<number>(raw.consumed),
          dismissed: asRecord<number>(raw.dismissed),
          cache: asRecord<CacheEntry>(raw.cache),
          pinned: typeof raw.pinned === 'number' ? raw.pinned : 0,
        };
      })
      .catch((err: unknown) => {
        // A failed read must not pin the store to a rejected promise; the next call retries.
        this.loading = undefined;
        throw err;
      });
    return this.loading;
  }

  /** Newest first. */
  async items(): Promise<ContextItem[]> {
    await this.load();
    return [...this.state.ctx].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  upsertPage(input: CaptureInput): Promise<ContextItem | undefined> {
    return this.upsert('page', input);
  }

  upsertSelection(input: CaptureInput): Promise<ContextItem | undefined> {
    return this.upsert('selection', input);
  }

  private async upsert(kind: ContextItem['kind'], input: CaptureInput): Promise<ContextItem | undefined> {
    await this.load();
    if (this.state.pinned) return undefined;
    const now = this.at();
    const location = parseLocation(input.url);
    if (!location) return undefined;
    const max = kind === 'page' ? LIMITS.pageTextChars : LIMITS.selectionTextChars;
    const text = truncate(normalizeWhitespace(input.text), max);
    if (!text) return undefined;
    const hash = hashText(text);
    const title = truncate(normalizeWhitespace(input.title), LIMITS.titleChars);

    const ctx = this.state.ctx;
    // One page item per tab; selections dedupe on identical text from the same tab.
    const existing =
      kind === 'page'
        ? ctx.find((i) => i.kind === 'page' && i.tabId === input.tabId)
        : ctx.find((i) => i.kind === 'selection' && i.tabId === input.tabId && i.hash === hash);

    let item: ContextItem;
    if (existing && existing.hash === hash) {
      existing.lastSeenAt = now;
      existing.title = title;
      item = existing;
    } else {
      if (existing) ctx.splice(ctx.indexOf(existing), 1);
      item = {
        id: this.newId(kind, hash, now),
        tabId: input.tabId,
        origin: location.origin,
        path: location.path,
        title,
        kind,
        text,
        hash,
        capturedAt: now,
        lastSeenAt: now,
      };
      ctx.push(item);
    }

    // Expired items go first so they never cost a live one its slot under the caps.
    this.evictExpired(now);
    this.enforceCaps();
    this.commit(['ctx']);
    return item;
  }

  /** Drop everything past its TTL. Cheap; runs on every write and on the alarm. */
  async sweep(): Promise<void> {
    await this.load();
    const changed = this.evictExpired(this.at());
    if (changed.length) this.write(changed);
  }

  /**
   * Freeze the store: no new captures land and the clock every TTL is measured
   * against stops, so nothing ages out until unpinned. Meant for a demo that a
   * stray tab must not derail. Session-only, like the rest of the store.
   */
  async pin(): Promise<void> {
    await this.load();
    if (this.state.pinned) return;
    this.state.pinned = this.now();
    this.commit(['pinned']);
  }

  /** Resume; anything past its TTL by real time goes out with this write. */
  async unpin(): Promise<void> {
    await this.load();
    if (!this.state.pinned) return;
    this.state.pinned = 0;
    this.commit(['pinned']);
  }

  async isPinned(): Promise<boolean> {
    await this.load();
    return this.state.pinned !== 0;
  }

  /** The time the store measures freshness against: real time, or the moment it was pinned. */
  async clock(): Promise<number> {
    await this.load();
    return this.at();
  }

  async markConsumed(key: string): Promise<void> {
    await this.load();
    this.state.consumed[key] = this.at() + STORE_LIMITS.consumedTtlMs;
    delete this.state.dismissed[key];
    this.commit(['consumed', 'dismissed']);
  }

  async markDismissed(key: string): Promise<void> {
    await this.load();
    this.state.dismissed[key] = this.at() + STORE_LIMITS.dismissedTtlMs;
    this.commit(['dismissed']);
  }

  /** Live consumed + dismissed keys. */
  async suppressedKeys(): Promise<string[]> {
    await this.load();
    const now = this.at();
    const live = (set: ExpiringSet) => Object.keys(set).filter((k) => (set[k] ?? 0) > now);
    return [...new Set([...live(this.state.consumed), ...live(this.state.dismissed)])];
  }

  async isSuppressed(key: string): Promise<boolean> {
    await this.load();
    const now = this.at();
    return (this.state.consumed[key] ?? 0) > now || (this.state.dismissed[key] ?? 0) > now;
  }

  async getCached(key: string): Promise<Suggestion[] | undefined> {
    await this.load();
    const entry = this.state.cache[key];
    if (!entry) return undefined;
    if (entry.expiresAt <= this.at()) {
      delete this.state.cache[key];
      this.write(['cache']);
      return undefined;
    }
    return entry.suggestions;
  }

  async setCached(key: string, suggestions: Suggestion[]): Promise<void> {
    await this.load();
    this.state.cache[key] = { suggestions, expiresAt: this.at() + STORE_LIMITS.cacheTtlMs };
    this.commit(['cache']);
  }

  async clear(): Promise<void> {
    await this.load();
    this.state = emptyState();
    const removed = this.chain.then(() => this.area.remove([...STORE_KEYS]));
    this.chain = removed.catch(() => undefined);
    await removed;
  }

  /** Resolves once every queued write has reached the storage area. */
  flush(): Promise<void> {
    return this.chain;
  }

  /** Every write is also a sweep: expired entries go out with whatever changed. */
  private commit(keys: StoreKey[]): void {
    const swept = this.evictExpired(this.at());
    this.write([...new Set([...keys, ...swept])]);
  }

  private evictExpired(now: number): StoreKey[] {
    const changed: StoreKey[] = [];
    const before = this.state.ctx.length;
    this.state.ctx = this.state.ctx.filter((i) => now - i.lastSeenAt < STORE_LIMITS.itemTtlMs);
    if (this.state.ctx.length !== before) changed.push('ctx');
    if (pruneExpiring(this.state.consumed, now)) changed.push('consumed');
    if (pruneExpiring(this.state.dismissed, now)) changed.push('dismissed');
    let cacheChanged = false;
    for (const [k, v] of Object.entries(this.state.cache)) {
      if (v.expiresAt <= now) {
        delete this.state.cache[k];
        cacheChanged = true;
      }
    }
    if (cacheChanged) changed.push('cache');
    return changed;
  }

  private enforceCaps(): void {
    const ctx = this.state.ctx;
    const oldestFirst = (kind?: ContextItem['kind']) =>
      ctx.filter((i) => !kind || i.kind === kind).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    const drop = (item: ContextItem) => ctx.splice(ctx.indexOf(item), 1);

    for (const s of oldestFirst('selection')) {
      if (ctx.filter((i) => i.kind === 'selection').length <= STORE_LIMITS.maxSelections) break;
      drop(s);
    }
    for (const i of oldestFirst()) {
      if (ctx.length <= STORE_LIMITS.maxItems) break;
      drop(i);
    }
    for (const i of oldestFirst()) {
      if (byteLength(ctx) <= STORE_LIMITS.maxBytes || ctx.length <= 1) break;
      drop(i);
    }
  }

  // Writes are queued so two rapid mutations can never land out of order.
  private write(keys: StoreKey[]): void {
    const snapshot: Record<string, unknown> = {};
    for (const k of keys) snapshot[k] = structuredClone(this.state[k]);
    this.chain = this.chain.then(() => this.area.set(snapshot)).catch(() => undefined);
  }

  private at(): number {
    return this.state.pinned || this.now();
  }

  private newId(kind: ContextItem['kind'], hash: number, now: number): string {
    this.seq = (this.seq + 1) % 1296;
    return `${kind[0]}${now.toString(36)}${hash.toString(36)}${this.seq.toString(36).padStart(2, '0')}`;
  }
}

function emptyState(): State {
  return { ctx: [], consumed: {}, dismissed: {}, cache: {}, pinned: 0 };
}

function asRecord<T>(v: unknown): Record<string, T> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

function pruneExpiring(set: ExpiringSet, now: number): boolean {
  let changed = false;
  for (const [k, exp] of Object.entries(set)) {
    if (exp <= now) {
      delete set[k];
      changed = true;
    }
  }
  return changed;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Query and hash are dropped: they carry ids and tokens the store must never keep. */
export function parseLocation(url: string): { origin: string; path: string } | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return { origin: u.origin, path: u.pathname };
  } catch {
    return undefined;
  }
}
