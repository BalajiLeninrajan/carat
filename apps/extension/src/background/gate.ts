import type { ContextItem, FieldDescriptor, PageMeta, Settings } from '@carat/shared';
import { isDenylisted } from '@carat/shared';
import { isSiteOff } from '../store';
import type { GateVerdict } from './diag';
import { isForeign, isFresh } from './eligible';
import type { Requester } from './requester';
import { ownContext } from './score';

export interface GateInput {
  page: PageMeta;
  fields: FieldDescriptor[];
}

/** Whether a request is worth a provider call: something to fill and either other tabs' text or the page's own. */
export function gate(
  input: GateInput,
  items: ContextItem[],
  settings: Settings,
  requester: Requester,
  now: number = Date.now(),
): boolean {
  return explainGate(input, items, settings, requester, now) === 'ok';
}

/**
 * Same checks as `gate`, but says which one stopped the request. Fresh text
 * from another tab and origin feeds fills; the requesting tab's own fresh text
 * feeds actions. Either is enough to ask.
 */
export function explainGate(
  input: GateInput,
  items: ContextItem[],
  settings: Settings,
  requester: Requester,
  now: number = Date.now(),
): GateVerdict {
  if (!settings.enabled) return 'disabled';
  if (isSiteOff(settings, input.page.host)) return 'site-off';
  if (isDenylisted(input.page.host)) return 'denylisted';
  if (input.fields.length === 0) return 'no-fields';
  if (items.length === 0) return 'no-context';
  const fresh = items.filter((i) => isFresh(i, now));
  if (fresh.length === 0) return 'stale-context';
  if (fresh.some((i) => isForeign(i, requester))) return 'ok';
  if (ownContext(items, requester, now).length > 0) return 'ok';
  // Fresh text exists but is neither another site's nor this tab's own: another tab on the same site.
  return 'own-context';
}
