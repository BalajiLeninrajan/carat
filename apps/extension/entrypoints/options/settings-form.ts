import { DEFAULT_SETTINGS, type Settings } from '@carat/shared';

export interface SettingsFormValues {
  enabled: boolean;
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  statusLine: boolean;
  cfAccountId: string;
  cfApiToken: string;
  smartModel: string;
  screenshots: boolean;
}

const PROVIDERS: ReadonlySet<Settings['provider']> = new Set(['openai', 'baseten', 'local', 'cloudflare']);

// Blank URL/model fall back to the documented defaults so a cleared field can
// never produce a request to "/chat/completions" or a request with model "".
// Trailing slashes are stripped because the provider concatenates the path.
export function normalizeSettings(v: SettingsFormValues): Partial<Settings> {
  const baseURL = v.baseURL.trim().replace(/\/+$/, '');
  const model = v.model.trim();
  const smartModel = v.smartModel.trim();
  return {
    enabled: v.enabled,
    provider: PROVIDERS.has(v.provider as Settings['provider'])
      ? (v.provider as Settings['provider'])
      : DEFAULT_SETTINGS.provider,
    baseURL: baseURL === '' ? DEFAULT_SETTINGS.baseURL : baseURL,
    apiKey: v.apiKey.trim(),
    model: model === '' ? DEFAULT_SETTINGS.model : model,
    statusLine: v.statusLine,
    cfAccountId: v.cfAccountId.trim(),
    cfApiToken: v.cfApiToken.trim(),
    smartModel: smartModel === '' ? DEFAULT_SETTINGS.smartModel : smartModel,
    screenshots: v.screenshots,
  };
}
