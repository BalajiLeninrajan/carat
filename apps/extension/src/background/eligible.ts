import type { ContextItem } from '@carat/shared';
import type { Requester } from './requester';

export const FRESH_MS = 10 * 60_000;

/**
 * Context the model may see for this request: seen in the last 10 minutes, from
 * another tab and another origin. Same-tab or same-origin text is what the user
 * is already looking at, so it would only produce echoes.
 */
export function eligibleContext(items: ContextItem[], requester: Requester, now: number): ContextItem[] {
  return items.filter(
    (i) =>
      now - i.lastSeenAt < FRESH_MS &&
      (requester.tabId === undefined || i.tabId !== requester.tabId) &&
      i.origin !== requester.origin,
  );
}
