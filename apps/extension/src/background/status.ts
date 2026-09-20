import type { Settings } from '@carat/shared';
import { isDenylisted } from '@carat/shared';
import { isSiteOff, parseLocation } from '../store';

export type StatusReason = 'disabled' | 'site-off' | 'denylisted' | 'not-http';

/** Everything the status line shows. Built from settings and the asking tab's URL; carries no secret. */
export interface StatusInfo {
  /** The user turned the status line on. */
  show: boolean;
  /** Carat reads and suggests on this page. */
  running: boolean;
  reason?: StatusReason;
  provider: Settings['provider'];
  /** The model name shown to the user; "local" when the regex fallback is what will answer. */
  model: string;
}

export function describeStatus(settings: Settings, url: string | undefined): StatusInfo {
  const location = url ? parseLocation(url) : undefined;
  const host = location ? new URL(location.origin).host : '';
  const reason = settings.enabled === false
    ? 'disabled'
    : !location
      ? 'not-http'
      : isDenylisted(new URL(location.origin).hostname)
        ? 'denylisted'
        : isSiteOff(settings, host)
          ? 'site-off'
          : undefined;
  const base: Omit<StatusInfo, 'provider' | 'model'> = {
    show: settings.statusLine,
    running: reason === undefined,
    ...(reason ? { reason } : {}),
  };
  // The same rules createProvider applies. Cloudflare with an account id and token asks Jev first,
  // then the chat model when a key is set too; without those credentials it behaves like openai.
  const jev = settings.provider === 'cloudflare' && settings.cfAccountId !== '' && settings.cfApiToken !== '';
  if (jev) return { ...base, provider: 'cloudflare', model: settings.apiKey === '' ? 'jev' : `jev+${settings.model}` };
  // No key means the regex provider answers, whatever the setting says.
  const local = settings.provider === 'local' || settings.apiKey === '';
  return { ...base, provider: local ? 'local' : settings.provider, model: local ? 'local' : settings.model };
}
