import { STORE_LIMITS } from './limits';
import type { StorageArea } from './storage-area';

export interface Shot {
  tabId: number;
  url: string;
  title: string;
  dataUrl: string; // downscaled JPEG
  capturedAt: number;
}

const KEY = 'shots';

/**
 * Screenshots waiting to be read into text. They live under their own
 * session key, apart from the context store, so an image never rides along
 * with a text write and the sweep can drop them on a shorter clock: three
 * minutes, at most two, one per tab. Every operation goes through one chain,
 * so a put and a take cannot interleave, and every operation evicts expired
 * shots first.
 */
export class ShotStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly area: StorageArea,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Replaces any shot of the same tab; the oldest goes when the cap is hit. */
  put(shot: Omit<Shot, 'capturedAt'>): Promise<void> {
    return this.run((live) => {
      const next = live.filter((s) => s.tabId !== shot.tabId);
      next.push({ ...shot, capturedAt: this.now() });
      next.sort((a, b) => a.capturedAt - b.capturedAt);
      while (next.length > STORE_LIMITS.maxShots) next.shift();
      return next;
    });
  }

  /** Removes and returns the live shot of a tab, if any. */
  async take(tabId: number): Promise<Shot | undefined> {
    let taken: Shot | undefined;
    await this.run((live) => {
      taken = live.find((s) => s.tabId === tabId);
      return live.filter((s) => s !== taken);
    });
    return taken;
  }

  remove(tabId: number): Promise<void> {
    return this.run((live) => live.filter((s) => s.tabId !== tabId));
  }

  async live(): Promise<Shot[]> {
    let out: Shot[] = [];
    await this.run((live) => (out = live));
    return out;
  }

  /** Drops expired shots. Cheap; runs on the alarm. */
  sweep(): Promise<void> {
    return this.run((live) => live);
  }

  clear(): Promise<void> {
    const step = this.chain.then(() => this.area.remove([KEY]));
    this.chain = step.catch(() => undefined);
    return step;
  }

  private run(fn: (live: Shot[]) => Shot[]): Promise<void> {
    const step = this.chain.then(async () => {
      const raw = (await this.area.get([KEY]))[KEY];
      const before = Array.isArray(raw) ? (raw as Shot[]) : [];
      const now = this.now();
      const next = fn(before.filter((s) => now - s.capturedAt < STORE_LIMITS.shotTtlMs));
      const changed = next.length !== before.length || next.some((s, i) => s !== before[i]);
      if (!changed) return;
      if (next.length === 0) await this.area.remove([KEY]);
      else await this.area.set({ [KEY]: next });
    });
    this.chain = step.catch(() => undefined);
    return step;
  }
}
