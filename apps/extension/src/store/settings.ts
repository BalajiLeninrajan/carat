import type { Settings } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
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
    cfAccountId: str(r.cfAccountId, DEFAULT_SETTINGS.cfAccountId).trim(),
    cfApiToken: str(r.cfApiToken, DEFAULT_SETTINGS.cfApiToken).trim(),
    disabledHosts: hosts(r.disabledHosts),
    statusLine: typeof r.statusLine === 'boolean' ? r.statusLine : DEFAULT_SETTINGS.statusLine,
  };
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
