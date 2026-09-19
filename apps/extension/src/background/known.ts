import { truncate } from '@carat/shared';
import type { KnownItem } from '../messaging';
import type { ContextStore } from '../store';
import { STORE_LIMITS } from '../store';

export async function getKnown(store: ContextStore): Promise<{ items: KnownItem[]; pinned: boolean }> {
  const [items, pinned] = await Promise.all([store.items(), store.isPinned()]);
  return {
    items: items.map((i) => ({
      id: i.id,
      origin: i.origin,
      title: i.title,
      kind: i.kind,
      capturedAt: i.capturedAt,
      preview: truncate(i.text, STORE_LIMITS.previewChars),
    })),
    pinned,
  };
}

export function clearKnown(store: ContextStore): Promise<void> {
  return store.clear();
}

export async function setPinned(store: ContextStore, pinned: boolean): Promise<{ pinned: boolean }> {
  if (pinned) await store.pin();
  else await store.unpin();
  return { pinned: await store.isPinned() };
}
