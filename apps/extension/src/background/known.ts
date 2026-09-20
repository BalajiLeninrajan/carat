import { truncate } from '@carat/shared';
import type { KnownItem } from '../messaging';
import type { ContextStore } from '../store';
import { STORE_LIMITS } from '../store';

export async function getKnown(
  store: ContextStore,
  goal?: { current(): Promise<string | undefined> },
): Promise<{ items: KnownItem[]; pinned: boolean; goal?: string }> {
  const [items, pinned, line] = await Promise.all([
    store.items(),
    store.isPinned(),
    goal?.current().catch(() => undefined) ?? undefined,
  ]);
  return {
    ...(line ? { goal: line } : {}),
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
