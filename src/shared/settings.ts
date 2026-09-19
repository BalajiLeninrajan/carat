/** User settings, persisted in chrome.storage.local. */
export interface Settings {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  /** Model for ghost text; should be the fastest one you have. */
  textModel: string;
  /** Model for next-action prediction; can afford to be smarter. */
  actionModel: string;
  /** OpenAI service_tier; "priority" trades cost for latency. */
  serviceTier: "auto" | "default" | "priority";
  textEnabled: boolean;
  actionsEnabled: boolean;
  /** Hostnames Carat never touches (suffix match). */
  blocklist: string[];
}

// Model id carried over from the original plan; change here if the API rejects it.
export const DEFAULT_MODEL = "gpt-5.6-luna";

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  textModel: DEFAULT_MODEL,
  actionModel: DEFAULT_MODEL,
  serviceTier: "auto",
  textEnabled: true,
  actionsEnabled: true,
  blocklist: [],
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  return chrome.storage.local.set(patch);
}

export function isBlocked(settings: Settings, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  return settings.blocklist.some((b) => host === b || host.endsWith("." + b));
}
