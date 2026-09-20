import { DEFAULT_ACCEPT_KEY, type AcceptKeyName } from "../../chip/accept-key";
import { isDenylisted } from "../../denylist";

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
  /**
   * Ours: read the system clipboard, so text copied in another app or another
   * Chrome profile is context too. Off until the user turns it on, and it does
   * nothing until Chrome grants the optional `clipboardRead` permission. What
   * the user copies inside the browser is remembered either way.
   */
  clipboardRead: boolean;
  /** Hostnames Caret never touches (suffix match). */
  blocklist: string[];
  /** Ours: the pill in the bottom-left corner that says whether Caret is running here. */
  statusLine: boolean;
  /** Ours: the chip's short note on accept. Off means no AudioContext is ever built. */
  sound: boolean;
  /**
   * Ours: which key answers a chip and takes ghost text. A tap of the right
   * Shift by default, which leaves Tab to the browser; Tab for anyone who
   * wants the editor's key and does not mind a chip swallowing it.
   */
  acceptKey: AcceptKeyName;
  /**
   * Ours: optional Elasticsearch context layer. With a URL and an API key,
   * the accessibility tree of every page read, the facts distilled from it and
   * the chips accepted or dismissed are indexed under `elasticIndexPrefix`,
   * and the open task is retrieved before each prediction.
   */
  elasticUrl: string;
  elasticApiKey: string;
  elasticIndexPrefix: string;
  /**
   * Optional Elastic inference endpoint for `semantic_text`. Blank keeps
   * retrieval lexical; "default" uses the deployment default; an endpoint id
   * such as ".elser-2-elasticsearch" turns on RRF hybrid retrieval.
   */
  elasticInferenceId: string;
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
  clipboardRead: false,
  blocklist: [],
  statusLine: false,
  sound: true,
  acceptKey: DEFAULT_ACCEPT_KEY,
  elasticUrl: "",
  elasticApiKey: "",
  elasticIndexPrefix: "caret",
  elasticInferenceId: "",
};

/** Index names allow a narrow character set, and a blank prefix is not one. */
export function indexPrefix(v: string): string {
  const cleaned = v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || DEFAULT_SETTINGS.elasticIndexPrefix;
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS as unknown as Record<string, unknown>);
  const settings = { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
  // The options page saves every field, so an old default sticks unless moved on here.
  for (const key of ["textModel", "actionModel"] as const) {
    if (PREVIOUS_DEFAULT_MODELS.includes(settings[key])) settings[key] = DEFAULT_MODEL;
  }
  // A trailing slash on the URL doubles up with every path we build.
  settings.elasticUrl = settings.elasticUrl.trim().replace(/\/+$/, "");
  settings.elasticApiKey = settings.elasticApiKey.trim();
  settings.elasticIndexPrefix = indexPrefix(settings.elasticIndexPrefix);
  settings.elasticInferenceId = settings.elasticInferenceId.trim();
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
  // Ours: banks, identity providers and password managers are off whatever the user's own list says.
  if (isDenylisted(host)) return true;
  return settings.blocklist.some((b) => host === b || host.endsWith("." + b));
}
