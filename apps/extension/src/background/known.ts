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

/** The three session stores a clear wipes: context (pin and all), screenshots, predicted entities. */
export interface Clearable {
  store: ContextStore;
  shots: { clear(): Promise<void> };
  entities: { clear(): Promise<void> };
}

/**
 * Everything "clear" means, in one place: the popup's button and the keyboard
 * shortcut both end here. Settings are untouched.
 */
export async function clearAll(what: Clearable): Promise<void> {
  await Promise.all([clearKnown(what.store), what.shots.clear(), what.entities.clear()]);
}

export async function setPinned(store: ContextStore, pinned: boolean): Promise<{ pinned: boolean }> {
  if (pinned) await store.pin();
  else await store.unpin();
  return { pinned: await store.isPinned() };
}
