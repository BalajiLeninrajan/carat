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
  /**
   * Reading memory: when you leave a page, a model call notes the facts on it
   * you might act on elsewhere, and later prompts include them. Opt-in, since
   * distilled page content is sent to the API.
   */
  memoryEnabled: boolean;
  /**
   * Background listening: the microphone runs (only while a Chrome window is
   * focused), speech is transcribed with OpenAI. Opt-in.
   */
  listenEnabled: boolean;
  /** OpenAI speech-to-text model. */
  transcribeModel: string;
  /** Hostnames Carat never touches (suffix match). */
  blocklist: string[];
}

// Picked by the model × reasoning ablation (npm run eval): as accurate as the
// alternatives with no reasoning, and the tightest latency tail for ghost text.
export const DEFAULT_MODEL = "gpt-5.6-luna";
/** Earlier defaults: stored settings still on one of these follow the new default. */
export const PREVIOUS_DEFAULT_MODELS = ["gpt-5.6-luna"];

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  textModel: DEFAULT_MODEL,
  actionModel: DEFAULT_MODEL,
  serviceTier: "auto",
  textEnabled: true,
  actionsEnabled: true,
  memoryEnabled: false,
  listenEnabled: false,
  transcribeModel: "gpt-transcribe",
  blocklist: [],
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
  // The options page saves every field, so an old default sticks unless moved on here.
  for (const key of ["textModel", "actionModel"] as const) {
    if (PREVIOUS_DEFAULT_MODELS.includes(settings[key])) settings[key] = DEFAULT_MODEL;
  }
  return settings;
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
