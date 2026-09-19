export const STORE_LIMITS = {
  maxItems: 20,
  maxBytes: 64 * 1024,
  maxSelections: 5,
  itemTtlMs: 30 * 60_000,
  consumedTtlMs: 30 * 60_000,
  dismissedTtlMs: 10 * 60_000,
  cacheTtlMs: 60_000,
  filledTtlMs: 60_000,
  previewChars: 120,
} as const;

export const STORE_KEYS = ['ctx', 'consumed', 'dismissed', 'cache', 'pinned', 'filled'] as const;
export type StoreKey = (typeof STORE_KEYS)[number];
