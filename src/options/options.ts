import { loadSettings, saveSettings, type Settings } from "../shared/settings.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const textKeys = ["apiKey", "baseUrl", "textModel", "actionModel", "serviceTier", "transcribeModel"] as const;
const boolKeys = ["enabled", "textEnabled", "actionsEnabled", "memoryEnabled", "listenEnabled"] as const;

async function init() {
  const s = await loadSettings();
  for (const k of textKeys) $<HTMLInputElement>(k).value = s[k];
  for (const k of boolKeys) $<HTMLInputElement>(k).checked = s[k];
  $<HTMLTextAreaElement>("blocklist").value = s.blocklist.join("\n");
}

async function save() {
  const patch: Partial<Settings> = {};
  for (const k of textKeys) (patch as Record<string, string>)[k] = $<HTMLInputElement>(k).value.trim();
  for (const k of boolKeys) patch[k] = $<HTMLInputElement>(k).checked;
  patch.baseUrl = patch.baseUrl!.replace(/\/+$/, "");
  patch.blocklist = $<HTMLTextAreaElement>("blocklist")
    .value.split(/\s+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  await saveSettings(patch);
  $("status").textContent = "Saved.";
  setTimeout(() => ($("status").textContent = ""), 1500);
}

$("save").addEventListener("click", save);

// The offscreen document that listens cannot show a permission prompt, so the
// extension's microphone permission is granted here, once, on a visible page.
async function micPermission(): Promise<PermissionState | "unknown"> {
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {
    return "unknown";
  }
}
async function showMicStatus() {
  const state = await micPermission();
  $("micStatus").textContent =
    state === "granted" ? " Microphone access granted." : state === "denied" ? " Microphone blocked: allow it in Chrome's site settings for this extension." : "";
}
$("grantMic").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    $("micStatus").textContent = ` Could not get the microphone: ${e instanceof Error ? e.message : e}`;
    return;
  }
  showMicStatus();
});
showMicStatus();
$("forget").addEventListener("click", async () => {
  await chrome.storage.session.remove("notes");
  chrome.runtime.sendMessage({ type: "carat-forget" }).catch(() => {});
  $("status").textContent = "Forgotten.";
  setTimeout(() => ($("status").textContent = ""), 1500);
});
init();
