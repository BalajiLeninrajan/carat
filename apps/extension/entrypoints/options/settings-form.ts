import {
  DEFAULT_SETTINGS,
  EAGERNESS_HELP,
  EAGERNESS_LEVELS,
  isEagerness,
  type Eagerness,
  type Settings,
} from '@carat/shared';

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
  eagerness: string;
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
    smartModel, // blank is a setting of its own: the fast model with low reasoning
    screenshots: v.screenshots,
    eagerness: isEagerness(v.eagerness) ? v.eagerness : DEFAULT_SETTINGS.eagerness,
  };
}

/**
 * The options page shows eagerness as a slider, one stop per level, in the
 * order EAGERNESS_LEVELS declares: 0 conservative, 1 balanced, 2 eager. Only
 * the position crosses the DOM; what gets saved is still the level's string.
 */
export const EAGERNESS_NAMES: Record<Eagerness, string> = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  eager: 'Eager',
};

/** The level at a slider position. An off-scale position falls back to the default. */
export function eagernessAt(position: number | string): Eagerness {
  const i = Math.round(Number(position));
  return EAGERNESS_LEVELS[i] ?? DEFAULT_SETTINGS.eagerness;
}

/** Where the thumb sits for a stored level. An unknown level sits at the default. */
export function eagernessPosition(level: string): number {
  const known = isEagerness(level) ? level : DEFAULT_SETTINGS.eagerness;
  return EAGERNESS_LEVELS.indexOf(known);
}

/** The one line under the track, for whichever level the thumb is on. */
export function eagernessNote(position: number | string): string {
  return EAGERNESS_HELP[eagernessAt(position)];
}
