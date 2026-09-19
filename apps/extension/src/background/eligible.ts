import type { ContextItem, Eagerness } from '@carat/shared';
import { DEFAULT_EAGERNESS, EAGERNESS } from '@carat/shared';
import { STORE_LIMITS } from '../store';
import type { Requester } from './requester';

/**
 * Anything still in the store is fresh enough to offer. The popup lists items
 * for 30 minutes, so a shorter window here would show context the user can
 * see but never get a chip from. Scoring still prefers the newest.
 */
export const FRESH_MS = STORE_LIMITS.itemTtlMs;

/**
 * Context the model may see for this request: seen in the last 30 minutes and
 * from another tab. Below eager it must be from another origin too, since
 * same-site text is usually what the user is already looking at; at eager a
 * different tab on the same site counts, because a wrong chip costs one Esc.
 * The requesting tab's own text never counts, at any level.
 */
export function eligibleContext(items: ContextItem[], requester: Requester, now: number, eagerness: Eagerness = DEFAULT_EAGERNESS): ContextItem[] {
  return items.filter((i) => isFresh(i, now) && isSource(i, requester, eagerness));
}

export function isFresh(item: ContextItem, now: number): boolean {
  return now - item.lastSeenAt < FRESH_MS;
}

/** From another tab and another origin than the one asking. */
export function isForeign(item: ContextItem, requester: Requester): boolean {
  return (requester.tabId === undefined || item.tabId !== requester.tabId) && item.origin !== requester.origin;
}

/** From a different tab than the one asking; false when the asker is not a tab, since then the two cannot be told apart. */
export function isOtherTab(item: ContextItem, requester: Requester): boolean {
  return requester.tabId !== undefined && item.tabId !== requester.tabId;
}

/** Whether an item may feed fills and interactions for this requester at this level. */
export function isSource(item: ContextItem, requester: Requester, eagerness: Eagerness): boolean {
  if (EAGERNESS[eagerness].sameOriginContext && isOtherTab(item, requester)) return true;
  return isForeign(item, requester);
}
