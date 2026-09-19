import type { HistoryEntry } from "./prompt.js";
import { scrubValue } from "../shared/redact.js";

/**
 * What the user has just been doing, per tab. Next-action prediction is mostly
 * a question about sequence - "they filled the last field, so they submit" -
 * and the page alone cannot say what happened a moment ago.
 *
 * Mirrored into chrome.storage.session so a recycled service worker (MV3 kills
 * idle ones after ~30s) does not forget the thread. Session storage is memory
 * only and cleared when the browser closes.
 */

const MAX_ENTRIES = 10;
/** Older than this, an entry says more about a different task than this one. */
const MAX_AGE_MS = 10 * 60 * 1000;

const memory = new Map<number, HistoryEntry[]>();

function key(tabId: number): string {
  return `history:${tabId}`;
}

async function load(tabId: number): Promise<HistoryEntry[]> {
  const cached = memory.get(tabId);
  if (cached) return cached;
  let entries: HistoryEntry[] = [];
  try {
    const stored = await chrome.storage.session.get(key(tabId));
    entries = (stored[key(tabId)] as HistoryEntry[] | undefined) ?? [];
  } catch {
    /* storage.session unavailable - memory only */
  }
  memory.set(tabId, entries);
  return entries;
}

export async function logEntry(tabId: number, entry: string): Promise<void> {
  const entries = await load(tabId);
  const clean = scrubValue(entry).replace(/\s+/g, " ").trim().slice(0, 200);
  if (!clean) return;
  // Collapse repeats ("typed in X" on every blur) into the latest one.
  const last = entries[entries.length - 1];
  if (last && last.entry === clean) {
    last.at = Date.now();
  } else {
    entries.push({ at: Date.now(), entry: clean });
  }
  while (entries.length > MAX_ENTRIES) entries.shift();
  try {
    await chrome.storage.session.set({ [key(tabId)]: entries });
  } catch {
    /* memory only */
  }
}

export async function recentHistory(tabId: number): Promise<HistoryEntry[]> {
  const now = Date.now();
  return (await load(tabId)).filter((e) => now - e.at < MAX_AGE_MS);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  memory.delete(tabId);
  void chrome.storage.session.remove(key(tabId)).catch(() => {});
});
