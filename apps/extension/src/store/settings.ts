import type { Settings } from '@carat/shared';
import { DEFAULT_SETTINGS, isEagerness } from '@carat/shared';
import type { StorageArea } from './storage-area';

const KEY = 'settings';
const PROVIDERS: ReadonlySet<Settings['provider']> = new Set(['openai', 'baseten', 'local', 'cloudflare']);

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
  const str = (v: unknown, fallback: string) => {
    if (typeof v !== 'string') return fallback;
    const text = v.trim();
    return text === 'undefined' || text === 'null' ? fallback : text;
  };
  const provider = PROVIDERS.has(r.provider as Settings['provider'])
    ? (r.provider as Settings['provider'])
    : DEFAULT_SETTINGS.provider;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SETTINGS.enabled,
    provider,
    baseURL: str(r.baseURL, DEFAULT_SETTINGS.baseURL).replace(/\/+$/, '') || DEFAULT_SETTINGS.baseURL,
    apiKey: str(r.apiKey, DEFAULT_SETTINGS.apiKey),
    model: str(r.model, DEFAULT_SETTINGS.model) || DEFAULT_SETTINGS.model,
    cfAccountId: str(r.cfAccountId, DEFAULT_SETTINGS.cfAccountId),
    cfApiToken: str(r.cfApiToken, DEFAULT_SETTINGS.cfApiToken),
    disabledHosts: hosts(r.disabledHosts),
    statusLine: typeof r.statusLine === 'boolean' ? r.statusLine : DEFAULT_SETTINGS.statusLine,
    screenshots: typeof r.screenshots === 'boolean' ? r.screenshots : DEFAULT_SETTINGS.screenshots,
    smartModel: str(r.smartModel, '') || legacySmartModel(r.visionModel),
    elasticUrl: str(r.elasticUrl, DEFAULT_SETTINGS.elasticUrl).replace(/\/+$/, ''),
    elasticApiKey: str(r.elasticApiKey, DEFAULT_SETTINGS.elasticApiKey),
    elasticIndexPrefix: indexPrefix(str(r.elasticIndexPrefix, DEFAULT_SETTINGS.elasticIndexPrefix)),
    elasticInferenceId: str(r.elasticInferenceId, DEFAULT_SETTINGS.elasticInferenceId),
    eagerness: isEagerness(r.eagerness) ? r.eagerness : DEFAULT_SETTINGS.eagerness,
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
const MAX_INDEX_PREFIX_CHARS = 48;

function indexPrefix(v: string): string {
  const cleaned = v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_INDEX_PREFIX_CHARS);
  return cleaned || DEFAULT_SETTINGS.elasticIndexPrefix;
}

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
