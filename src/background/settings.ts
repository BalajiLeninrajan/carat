import { DEFAULT_SETTINGS, type Settings } from "../shared/types.js";

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  cache = { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
  return cache;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  cache = next;
  await chrome.storage.local.set(next);
  return next;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !cache) return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    (cache as unknown as Record<string, unknown>)[key] = newValue;
  }
});
