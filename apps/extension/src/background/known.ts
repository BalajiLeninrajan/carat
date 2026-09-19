import { truncate } from '@carat/shared';
import type { KnownItem } from '../messaging';
import type { ContextStore } from '../store';
import { STORE_LIMITS } from '../store';

export async function getKnown(store: ContextStore): Promise<{ items: KnownItem[] }> {
  const items = await store.items();
  return {
    items: items.map((i) => ({
      id: i.id,
      origin: i.origin,
      title: i.title,
      kind: i.kind,
      capturedAt: i.capturedAt,
      preview: truncate(i.text, STORE_LIMITS.previewChars),
    })),
  };
}

export function clearKnown(store: ContextStore): Promise<void> {
  return store.clear();
}
