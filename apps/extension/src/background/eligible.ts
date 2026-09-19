import type { ContextItem } from '@carat/shared';
import { STORE_LIMITS } from '../store';
import type { Requester } from './requester';

/**
 * Anything still in the store is fresh enough to offer. The popup lists items
 * for 30 minutes, so a shorter window here would show context the user can
 * see but never get a chip from. Scoring still prefers the newest.
 */
export const FRESH_MS = STORE_LIMITS.itemTtlMs;

/**
 * Context the model may see for this request: seen in the last 30 minutes, from
 * another tab and another origin. Same-tab or same-origin text is what the user
 * is already looking at, so it would only produce echoes.
 */
export function eligibleContext(items: ContextItem[], requester: Requester, now: number): ContextItem[] {
  return items.filter((i) => isFresh(i, now) && isForeign(i, requester));
}

export function isFresh(item: ContextItem, now: number): boolean {
  return now - item.lastSeenAt < FRESH_MS;
}

/** From another tab and another origin than the one asking. */
export function isForeign(item: ContextItem, requester: Requester): boolean {
  return (requester.tabId === undefined || item.tabId !== requester.tabId) && item.origin !== requester.origin;
}
