import { truncate } from '@carat/shared';
import type { KnownItem } from '../messaging';
import type { ContextStore } from '../store';
import { STORE_LIMITS } from '../store';
import type { Note } from './notes';

/**
 * What the popup lists: the pages carat read and the copies it remembered, in
 * one list, newest first. A copy carries the `clipboard` kind, which the popup
 * shows as a "copied" tag.
 */
export async function getKnown(
  store: ContextStore,
  goal?: { current(): Promise<string | undefined> },
  notes?: { copies(): Promise<Note[]> },
): Promise<{ items: KnownItem[]; pinned: boolean; goal?: string }> {
  const [items, pinned, line, copies] = await Promise.all([
    store.items(),
    store.isPinned(),
    goal?.current().catch(() => undefined) ?? undefined,
    notes?.copies().catch(() => [] as Note[]) ?? [],
  ]);
  const read: KnownItem[] = items.map((i) => ({
    id: i.id,
    origin: i.origin,
    title: i.title,
    kind: i.kind,
    capturedAt: i.capturedAt,
    preview: truncate(i.text, STORE_LIMITS.previewChars),
  }));
  const copied: KnownItem[] = copies.map((n) => ({
    id: `copy-${n.at}`,
    origin: n.origin,
    title: n.title,
    kind: 'clipboard' as const,
    capturedAt: n.at,
    preview: truncate(n.text, STORE_LIMITS.previewChars),
  }));
  return {
    ...(line ? { goal: line } : {}),
    items: [...read, ...copied].sort((a, b) => b.capturedAt - a.capturedAt),
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
