import { loadSettings, saveSettings, type Settings } from "../shared/settings.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const textKeys = ["apiKey", "baseUrl", "textModel", "actionModel", "serviceTier"] as const;
const boolKeys = ["enabled", "textEnabled", "actionsEnabled", "memoryEnabled"] as const;

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
$("forget").addEventListener("click", async () => {
  await chrome.storage.session.remove("notes");
  $("status").textContent = "Forgotten.";
  setTimeout(() => ($("status").textContent = ""), 1500);
});
init();
