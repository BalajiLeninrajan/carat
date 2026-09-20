import type { AcceptKeyName } from '../chip/accept-key';
import { isDenylisted } from '../denylist';
import type { Settings } from '../engine/shared/settings';

export type StatusReason = 'disabled' | 'blocked' | 'no-key' | 'not-http' | 'paused';

/** Everything the status line shows. Built from settings and the asking tab's URL; carries no secret. */
export interface StatusInfo {
  /** The user turned the status line on. */
  show: boolean;
  /** Caret reads and suggests on this page. */
  running: boolean;
  reason?: StatusReason;
  /** The model that answers for next actions. Never the key. */
  model: string;
  /**
   * Whether the chip may make a sound on accept. The status line itself never
   * does; this rides along because the status poll is the one channel a page
   * has for a setting, and the chip should follow a change without a reload.
   */
  sound: boolean;
  /** Which key answers a chip, for the same reason: the keycap has to follow the setting. */
  acceptKey: AcceptKeyName;
}

function host(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

/** One line for a tab, from the settings and that tab's URL. `paused` is the debugger banner having been dismissed. */
export function describeStatus(settings: Settings, url: string | undefined, paused = false): StatusInfo {
  const h = host(url);
  const blocked = h !== null && (isDenylisted(h) || settings.blocklist.some((b) => h === b || h.endsWith(`.${b}`)));
  const reason: StatusReason | undefined = !settings.enabled
    ? 'disabled'
    : h === null
      ? 'not-http'
      : blocked
        ? 'blocked'
        : paused
          ? 'paused'
          : settings.apiKey === ''
            ? 'no-key'
            : undefined;
  return {
    show: settings.statusLine,
    running: reason === undefined,
    sound: settings.sound,
    acceptKey: settings.acceptKey,
    model: settings.actionModel,
    ...(reason ? { reason } : {}),
  };
}
