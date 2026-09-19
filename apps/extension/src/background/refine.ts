import type { RefineResponse } from '../messaging';

const GRACE_MS = 30_000;
const NONE: RefineResponse = { suggestions: [], interactions: [] };

/**
 * Smart answers in flight, keyed by the ticket the fast reply hands the
 * content script. The script long-polls `suggestRefine` with it; a ticket
 * answers once, and only the tab that received it. Memory only: a worker
 * restart forgets the ticket and the poll gets nothing, which the chip reads
 * as "nothing better".
 */
export class RefineQueue {
  private readonly pending = new Map<string, { tabId: number | undefined; result: Promise<RefineResponse> }>();

  constructor(private readonly setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms)) {}

  add(tabId: number | undefined, result: Promise<RefineResponse>): string {
    const ticket = newTicket();
    const safe = result.catch((): RefineResponse => NONE);
    this.pending.set(ticket, { tabId, result: safe });
    // An unclaimed ticket (the page navigated away) must not pin its answer forever.
    void safe.then(() => this.setTimer(() => this.pending.delete(ticket), GRACE_MS));
    return ticket;
  }

  claim(ticket: string, tabId: number | undefined): Promise<RefineResponse> {
    const entry = this.pending.get(ticket);
    if (!entry || entry.tabId !== tabId) return Promise.resolve(NONE);
    this.pending.delete(ticket);
    return entry.result;
  }

  get size(): number {
    return this.pending.size;
  }
}

function newTicket(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
