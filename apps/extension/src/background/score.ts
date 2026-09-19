import type { ContextItem, SuggestRequest } from '@carat/shared';
import { truncate } from '@carat/shared';
import { eligibleContext } from './eligible';
import type { Requester } from './requester';

export const CONTEXT_LIMITS = { maxItems: 3, maxChars: 3600 } as const;
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

/** Top 3 eligible items by score, clipped to fit 3600 chars of text in total. */
export function scoreAndPickContext(
  items: ContextItem[],
  requester: Requester,
  now: number = Date.now(),
): SuggestRequest['context'] {
  const ranked = eligibleContext(items, requester, now)
    .map((item) => ({ item, score: scoreItem(item, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CONTEXT_LIMITS.maxItems)
    .map(({ item }) => item);

  const budgets = shareBudget(
    ranked.map((item) => item.text.length),
    CONTEXT_LIMITS.maxChars,
  );
  return ranked.map((item, i) => ({
    id: item.id,
    origin: item.origin,
    title: item.title,
    kind: item.kind,
    text: truncate(item.text, budgets[i]!),
    capturedAt: item.capturedAt,
  }));
}
