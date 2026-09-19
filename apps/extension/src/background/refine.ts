import type { ActionUpdate } from '../messaging';
import type { StorageArea } from '../store';

const GRACE_MS = 30_000;
const NONE: ActionUpdate = {};
/** No worker holds this ticket any more; the page has to ask again rather than settle. */
const LOST: ActionUpdate = { lost: true };

/** Session key for the tickets that are open, beside the timeline and the answer cache. */
export const TICKETS_KEY = 'refineTickets';

/** A ticket the background pushes later words through until it closes it. */
export interface RefineTicket {
  readonly id: string;
  /** Move the ring, or replace the action. Ignored once closed. */
  push(update: ActionUpdate): void;
  /** Nothing more is coming; the poll after the last update gets nothing. */
  close(): void;
}

interface Entry {
  tabId: number | undefined;
  updates: ActionUpdate[];
  closed: boolean;
  waiting: Array<() => void>;
}

/** What survives the worker: enough to tell an open ticket from a closed one, and the answer if it landed. */
interface Saved {
  tabId: number | undefined;
  at: number;
  closed?: boolean;
  /** The last update that carried a whole action; a ring on its own is not worth keeping. */
  last?: ActionUpdate;
}

export interface RefineQueueOptions {
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** `chrome.storage.session`, so a restarted worker still knows which tickets were open. */
  area?: StorageArea;
  now?: () => number;
}

/**
 * Later words in flight, keyed by the ticket the first reply hands the
 * content script. The script long-polls `nextActionRefine` with it; each poll
 * gets the next update, marked `more` while the ticket is still open, and
 * nothing once it is closed and drained. Only the tab that received the
 * ticket may claim it.
 *
 * The updates live in the worker, but which tickets are open lives in
 * `chrome.storage.session`. A worker that goes down between the placeholder
 * and the model's answer comes back with no memory of either; without the
 * record it would answer the poll with nothing, which the chip reads as
 * "nothing better than the placeholder". With it, the poll is answered
 * `lost`, the answer is handed over if it had already landed, and the page
 * asks again.
 */
export class RefineQueue {
  private readonly pending = new Map<string, Entry>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly area: StorageArea | undefined;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: RefineQueueOptions = {}) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.area = opts.area;
    this.now = opts.now ?? (() => Date.now());
  }

  /** A ticket that answers as many times as something better lands, until it is closed. */
  open(tabId: number | undefined): RefineTicket {
    const id = newTicket();
    const entry: Entry = { tabId, updates: [], closed: false, waiting: [] };
    this.pending.set(id, entry);
    this.remember(id, { tabId, at: this.now() });
    const wake = (): void => {
      for (const resolve of entry.waiting.splice(0)) resolve();
    };
    return {
      id,
      push: (update) => {
        if (entry.closed) return;
        entry.updates.push(update);
        // A ring on its own is worth nothing to a later worker; an action is the answer itself.
        if (update.action !== undefined) this.edit(id, (saved) => ({ ...saved, last: { action: update.action ?? null } }));
        wake();
      },
      close: () => {
        if (entry.closed) return;
        entry.closed = true;
        this.edit(id, (saved) => ({ ...saved, closed: true }));
        wake();
        // An unclaimed ticket (the page navigated away) must not pin its updates forever.
        this.setTimer(() => this.drop(id), GRACE_MS);
      },
    };
  }

  async claim(ticket: string, tabId: number | undefined): Promise<ActionUpdate> {
    const entry = this.pending.get(ticket);
    if (entry) {
      if (entry.tabId !== tabId) return NONE;
      while (entry.updates.length === 0 && !entry.closed) {
        await new Promise<void>((resolve) => entry.waiting.push(resolve));
      }
      const next = entry.updates.shift();
      if (!next) {
        this.drop(ticket);
        return NONE;
      }
      if (entry.closed && entry.updates.length === 0) {
        this.drop(ticket);
        return next;
      }
      return { ...next, more: true };
    }

    // No worker memory of it. Either this worker never opened it, or the one that did is gone.
    const saved = await this.recall(ticket);
    if (!saved || saved.tabId !== tabId) return NONE;
    this.drop(ticket);
    if (saved.last) return saved.last;
    return saved.closed ? NONE : LOST;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Resolves once every queued write has reached the storage area. */
  flush(): Promise<void> {
    return this.chain.then(() => undefined);
  }

  private drop(id: string): void {
    this.pending.delete(id);
    this.forget(id);
  }

  private remember(id: string, saved: Saved): void {
    this.write((all) => ({ ...all, [id]: saved }));
  }

  private edit(id: string, fn: (saved: Saved) => Saved): void {
    this.write((all) => {
      const saved = all[id];
      return saved ? { ...all, [id]: fn(saved) } : all;
    });
  }

  private forget(id: string): void {
    this.write((all) => {
      if (!(id in all)) return all;
      const { [id]: _gone, ...rest } = all;
      return rest;
    });
  }

  private async recall(id: string): Promise<Saved | undefined> {
    const area = this.area;
    if (!area) return undefined;
    await this.flush();
    try {
      return this.prune(asSaved((await area.get([TICKETS_KEY]))[TICKETS_KEY]))[id];
    } catch {
      return undefined;
    }
  }

  private write(fn: (all: Record<string, Saved>) => Record<string, Saved>): void {
    const area = this.area;
    if (!area) return;
    this.chain = this.chain
      .then(async () => {
        const next = this.prune(fn(asSaved((await area.get([TICKETS_KEY]))[TICKETS_KEY])));
        if (Object.keys(next).length === 0) await area.remove([TICKETS_KEY]);
        else await area.set({ [TICKETS_KEY]: next });
      })
      .catch(() => undefined);
  }

  /** A ticket nobody claimed inside the grace window is not coming back for one. */
  private prune(all: Record<string, Saved>): Record<string, Saved> {
    const now = this.now();
    return Object.fromEntries(Object.entries(all).filter(([, saved]) => now - saved.at < GRACE_MS));
  }
}

function asSaved(v: unknown): Record<string, Saved> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, Saved> = {};
  for (const [id, saved] of Object.entries(v as Record<string, unknown>)) {
    if (saved && typeof saved === 'object' && typeof (saved as Saved).at === 'number') out[id] = saved as Saved;
  }
  return out;
}

function newTicket(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
