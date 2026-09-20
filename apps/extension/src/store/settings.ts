import type { Settings } from '@carat/shared';
import { DEFAULT_SETTINGS, isEagerness, isEvidenceSource } from '@carat/shared';
import type { StorageArea } from './storage-area';

const KEY = 'settings';
const PROVIDERS: ReadonlySet<Settings['provider']> = new Set(['openai', 'baseten', 'local']);

export interface SettingsStore {
  get(): Promise<Settings>;
  set(patch: Partial<Settings>): Promise<Settings>;
}

/** Settings live in chrome.storage.local; the keys never leave the background context. */
export function createSettingsStore(area: Pick<StorageArea, 'get' | 'set'>): SettingsStore {
  return {
    async get() {
      const raw = await area.get([KEY]);
      return sanitize(raw[KEY]);
    },
    async set(patch) {
      const current = await this.get();
      const next = sanitize({ ...current, ...patch });
      await area.set({ [KEY]: next });
      return next;
    },
  };
}

function sanitize(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  const provider = PROVIDERS.has(r.provider as Settings['provider'])
    ? (r.provider as Settings['provider'])
    : DEFAULT_SETTINGS.provider;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SETTINGS.enabled,
    provider,
    baseURL: str(r.baseURL, DEFAULT_SETTINGS.baseURL).trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.baseURL,
    apiKey: str(r.apiKey, DEFAULT_SETTINGS.apiKey).trim(),
    model: str(r.model, DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model,
    disabledHosts: hosts(r.disabledHosts),
    statusLine: typeof r.statusLine === 'boolean' ? r.statusLine : DEFAULT_SETTINGS.statusLine,
    sound: typeof r.sound === 'boolean' ? r.sound : DEFAULT_SETTINGS.sound,
    screenshots: typeof r.screenshots === 'boolean' ? r.screenshots : DEFAULT_SETTINGS.screenshots,
    smartModel: str(r.smartModel, '').trim() || legacySmartModel(r.visionModel),
    eagerness: isEagerness(r.eagerness) ? r.eagerness : DEFAULT_SETTINGS.eagerness,
    ghost: typeof r.ghost === 'boolean' ? r.ghost : DEFAULT_SETTINGS.ghost,
    evidence: isEvidenceSource(r.evidence) ? r.evidence : DEFAULT_SETTINGS.evidence,
  };
}

// `visionModel` is the name this setting had before, and every save wrote its
// default back, so a stored 'gpt-5.6' says nothing about what the user wanted.
// Anything else was typed in and carries over the first time it is read.
const OLD_SMART_DEFAULT = 'gpt-5.6';

function legacySmartModel(v: unknown): string {
  const model = typeof v === 'string' ? v.trim() : '';
  return model === OLD_SMART_DEFAULT ? '' : model;
}

const MAX_DISABLED_HOSTS = 200;

function hosts(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const h of v) {
    if (typeof h !== 'string') continue;
    const host = h.trim().toLowerCase();
    if (host) out.add(host);
    if (out.size >= MAX_DISABLED_HOSTS) break;
  }
  return [...out];
}
