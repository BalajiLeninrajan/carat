import type { RefineResponse } from '../messaging';

const GRACE_MS = 30_000;
const NONE: RefineResponse = { suggestions: [], interactions: [] };

/** A ticket the background pushes better answers through until it closes it. */
export interface RefineTicket {
  readonly id: string;
  /** Hand the content script a better answer. Ignored once closed. */
  push(answer: RefineResponse): void;
  /** Nothing more is coming; the poll after the last answer gets nothing. */
  close(): void;
}

interface Entry {
  tabId: number | undefined;
  answers: RefineResponse[];
  closed: boolean;
  waiting: Array<() => void>;
}

/**
 * Later answers in flight, keyed by the ticket the fast reply hands the
 * content script. The script long-polls `suggestRefine` with it; each poll
 * gets the next answer, marked `more` while the ticket is still open, and
 * nothing once it is closed and drained. Only the tab that received the
 * ticket may claim it. Memory only: a worker restart forgets the ticket and
 * the poll gets nothing, which the chip reads as "nothing better".
 */
export class RefineQueue {
  private readonly pending = new Map<string, Entry>();

  constructor(private readonly setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms)) {}

  /** One answer, then done. A rejected promise answers nothing. */
  add(tabId: number | undefined, result: Promise<RefineResponse>): string {
    const ticket = this.open(tabId);
    void result.then(
      (answer) => ticket.push(answer),
      () => undefined,
    ).finally(() => ticket.close());
    return ticket.id;
  }

  /** A ticket that answers as many times as something better lands, until it is closed. */
  open(tabId: number | undefined): RefineTicket {
    const id = newTicket();
    const entry: Entry = { tabId, answers: [], closed: false, waiting: [] };
    this.pending.set(id, entry);
    const wake = (): void => {
      for (const resolve of entry.waiting.splice(0)) resolve();
    };
    return {
      id,
      push: (answer) => {
        if (entry.closed) return;
        entry.answers.push(answer);
        wake();
      },
      close: () => {
        if (entry.closed) return;
        entry.closed = true;
        wake();
        // An unclaimed ticket (the page navigated away) must not pin its answers forever.
        this.setTimer(() => this.pending.delete(id), GRACE_MS);
      },
    };
  }

  async claim(ticket: string, tabId: number | undefined): Promise<RefineResponse> {
    const entry = this.pending.get(ticket);
    if (!entry || entry.tabId !== tabId) return NONE;
    while (entry.answers.length === 0 && !entry.closed) {
      await new Promise<void>((resolve) => entry.waiting.push(resolve));
    }
    const next = entry.answers.shift();
    if (!next) {
      this.pending.delete(ticket);
      return NONE;
    }
    if (entry.closed && entry.answers.length === 0) {
      this.pending.delete(ticket);
      return next;
    }
    return { ...next, more: true };
  }

  get size(): number {
    return this.pending.size;
  }
}

function newTicket(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
