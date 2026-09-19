import type { ContextItem, RequestContext } from '@carat/shared';
import { truncate } from '@carat/shared';
import { FRESH_MS, eligibleContext } from './eligible';
import type { Requester } from './requester';

export const CONTEXT_LIMITS = { maxItems: 3, maxChars: 3600 } as const;
/** The requesting tab's own text: its page plus at most one selection, in a smaller budget. */
export const OWN_LIMITS = { maxItems: 2, maxChars: 2000 } as const;
const HALF_LIFE_MS = 10 * 60_000;
const SELECTION_WEIGHT = 3;

export function scoreItem(item: ContextItem, now: number): number {
  const age = Math.max(0, now - item.lastSeenAt);
  return Math.exp(-age / HALF_LIFE_MS) * (item.kind === 'selection' ? SELECTION_WEIGHT : 1);
}

/**
 * Split `budget` across `lengths` so short items keep all their text and long items
 * share what is left evenly. Two full pages get 1800 each rather than 3400 and 200.
 */
function shareBudget(lengths: number[], budget: number): number[] {
  const order = lengths.map((len, i) => i).sort((a, b) => lengths[a]! - lengths[b]!);
  const out = new Array<number>(lengths.length).fill(0);
  let remaining = budget;
  order.forEach((i, rank) => {
    const share = Math.floor(remaining / (order.length - rank));
    out[i] = Math.min(lengths[i]!, share);
    remaining -= out[i]!;
  });
  return out;
}

function clip(items: ContextItem[], maxChars: number): RequestContext {
  const budgets = shareBudget(
    items.map((item) => item.text.length),
    maxChars,
  );
  return items.map((item, i) => ({
    id: item.id,
    origin: item.origin,
    title: item.title,
    kind: item.kind,
    text: truncate(item.text, budgets[i]!),
    capturedAt: item.capturedAt,
  }));
}

function rank(items: ContextItem[], now: number, max: number): ContextItem[] {
  return items
    .map((item) => ({ item, score: scoreItem(item, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ item }) => item);
}

/** Top 3 eligible items by score, clipped to fit 3600 chars of text in total. */
export function scoreAndPickContext(items: ContextItem[], requester: Requester, now: number = Date.now()): RequestContext {
  return clip(rank(eligibleContext(items, requester, now), now, CONTEXT_LIMITS.maxItems), CONTEXT_LIMITS.maxChars);
}

/**
 * What the requesting tab itself holds: the fresh page item, any transcript
 * read off its screenshot, and the best selection, clipped to 2000 chars.
 * The only source for actions.
 */
export function ownContext(items: ContextItem[], requester: Requester, now: number = Date.now()): RequestContext {
  if (requester.tabId === undefined) return [];
  const own = items.filter((i) => i.tabId === requester.tabId && now - i.lastSeenAt < FRESH_MS);
  const page = own.filter((i) => i.kind === 'page' || i.kind === 'vision');
  const selections = rank(own.filter((i) => i.kind === 'selection'), now, 1);
  return clip(rank([...page, ...selections], now, OWN_LIMITS.maxItems), OWN_LIMITS.maxChars);
}
