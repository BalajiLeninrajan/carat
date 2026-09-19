/**
 * The slice of chrome.storage.StorageArea the store relies on. Kept minimal so
 * tests can pass a plain in-memory object and so chrome.storage.session and
 * chrome.storage.local both satisfy it.
 */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
