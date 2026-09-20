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
  /**
   * Whether the chip may make a sound on Tab. The status line itself never
   * does; this rides along because the status poll is the one channel a page
   * has for a setting, and the chip should follow a change without a reload.
   */
  sound: boolean;
}

export function describeStatus(settings: Settings, url: string | undefined): StatusInfo {
  const location = url ? parseLocation(url) : undefined;
  const host = location ? new URL(location.origin).host : '';
  const reason = !settings.enabled
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
    sound: settings.sound,
    ...(reason ? { reason } : {}),
  };
  // The same rules createProvider applies.
  // No key means the regex provider answers, whatever the setting says.
  const local = settings.provider === 'local' || settings.apiKey === '';
  return { ...base, provider: local ? 'local' : settings.provider, model: local ? 'local' : settings.model };
}
