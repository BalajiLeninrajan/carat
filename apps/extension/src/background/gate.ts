import type { OutlineControl, Settings } from '@carat/shared';
import { isDenylisted } from '@carat/shared';
import { isSiteOff } from '../store';
import type { GateVerdict } from './diag';

export interface GateInput {
  page: { host: string };
  outline: string;
  controls: OutlineControl[];
  /** The content script saw a visible password field. */
  password?: boolean;
}

const PASSWORD_NAME = /\b(password|passcode|one[- ]time code|security code)\b/i;

/**
 * Whether a snapshot is worth asking about. Carat predicts the next action on
 * the page the user is on, so the bar is a page it may act on: the global
 * switch, the per-site switch and the denylist all stop it, and so does a
 * page with a password field, whether the content script flagged it or a
 * control on it is plainly one.
 */
export function gate(input: GateInput, settings: Settings): boolean {
  return explainGate(input, settings) === 'ok';
}

/** Same checks as `gate`, but says which one stopped the request. */
export function explainGate(input: GateInput, settings: Settings): GateVerdict {
  if (!settings.enabled) return 'disabled';
  if (isSiteOff(settings, input.page.host)) return 'site-off';
  if (isDenylisted(input.page.host)) return 'denylisted';
  if (input.password || input.controls.some((c) => PASSWORD_NAME.test(c.name))) return 'password';
  if (!hasWork(input)) return 'no-snapshot';
  return 'ok';
}

/** Something to answer about: an outline with text in it, or at least one control. */
export function hasWork(input: Pick<GateInput, 'outline' | 'controls'>): boolean {
  return input.outline.trim().length > 0 || input.controls.length > 0;
}
