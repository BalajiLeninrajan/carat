import { DEFAULT_SETTINGS, type Settings } from "../shared/types.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const fields = {
  apiKey: el<HTMLInputElement>("apiKey"),
  model: el<HTMLInputElement>("model"),
  api: el<HTMLSelectElement>("api"),
  baseUrl: el<HTMLInputElement>("baseUrl"),
  enabled: el<HTMLInputElement>("enabled"),
  useAccessibilityTree: el<HTMLInputElement>("useAccessibilityTree"),
  predictActions: el<HTMLInputElement>("predictActions"),
  actionConfidence: el<HTMLInputElement>("actionConfidence"),
  debounceMs: el<HTMLInputElement>("debounceMs"),
  maxOutputTokens: el<HTMLInputElement>("maxOutputTokens"),
  blocklist: el<HTMLTextAreaElement>("blocklist"),
};

const status = el<HTMLSpanElement>("status");

function setStatus(message: string, kind: "" | "ok" | "bad" = ""): void {
  status.textContent = message;
  status.className = kind;
}

async function load(): Promise<void> {
  const stored = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as Settings;
  fields.apiKey.value = stored.apiKey;
  fields.model.value = stored.model;
  fields.api.value = stored.api;
  fields.baseUrl.value = stored.baseUrl;
  fields.enabled.checked = stored.enabled;
  fields.useAccessibilityTree.checked = stored.useAccessibilityTree;
  fields.predictActions.checked = stored.predictActions;
  fields.actionConfidence.value = String(stored.actionConfidence);
  fields.debounceMs.value = String(stored.debounceMs);
  fields.maxOutputTokens.value = String(stored.maxOutputTokens);
  fields.blocklist.value = stored.blocklist.join("\n");
}

function collect(): Settings {
  return {
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim() || DEFAULT_SETTINGS.model,
    api: fields.api.value === "chat" ? "chat" : "responses",
    baseUrl: fields.baseUrl.value.trim().replace(/\/$/, "") || DEFAULT_SETTINGS.baseUrl,
    enabled: fields.enabled.checked,
    useAccessibilityTree: fields.useAccessibilityTree.checked,
    predictActions: fields.predictActions.checked,
    actionConfidence: clampFloat(Number(fields.actionConfidence.value), 0, 1, DEFAULT_SETTINGS.actionConfidence),
    debounceMs: clamp(Number(fields.debounceMs.value), 80, 2000, DEFAULT_SETTINGS.debounceMs),
    maxOutputTokens: clamp(Number(fields.maxOutputTokens.value), 8, 256, DEFAULT_SETTINGS.maxOutputTokens),
    blocklist: fields.blocklist.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function clampFloat(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

async function save(): Promise<void> {
  const settings = collect();
  await chrome.storage.local.set(settings);
  await chrome.runtime.sendMessage({ type: "carat:settings-changed" }).catch(() => undefined);
  setStatus("Saved.", "ok");
}

/**
 * A one-shot, non-streaming call. Mostly here to tell you straight away whether
 * the configured model id actually exists on your account.
 */
async function test(): Promise<void> {
  const settings = collect();
  if (!settings.apiKey) {
    setStatus("Add an API key first.", "bad");
    return;
  }
  setStatus("Testing…");
  const started = performance.now();

  const url = `${settings.baseUrl}/${settings.api === "chat" ? "chat/completions" : "responses"}`;
  const body =
    settings.api === "chat"
      ? {
          model: settings.model,
          messages: [{ role: "user", content: "Reply with the single word: ready" }],
          max_completion_tokens: 8,
        }
      : {
          model: settings.model,
          input: "Reply with the single word: ready",
          max_output_tokens: 16,
        };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as {
      error?: { message?: string };
      model?: string;
    };
    const ms = Math.round(performance.now() - started);

    if (!response.ok) {
      setStatus(payload.error?.message ?? `HTTP ${response.status}`, "bad");
      return;
    }
    setStatus(`OK — ${payload.model ?? settings.model} responded in ${ms} ms.`, "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "bad");
  }
}

el<HTMLButtonElement>("save").addEventListener("click", () => void save());
el<HTMLButtonElement>("test").addEventListener("click", () => void test());
void load();
