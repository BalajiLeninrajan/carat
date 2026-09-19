import type { ContextItem, FieldDescriptor, PageMeta, Settings } from '@carat/shared';
import { isDenylisted } from '@carat/shared';
import { isSiteOff } from '../store';
import type { GateVerdict } from './diag';
import { isForeign, isFresh } from './eligible';
import type { Requester } from './requester';

export interface GateInput {
  page: PageMeta;
  fields: FieldDescriptor[];
}

export function gate(
  input: GateInput,
  items: ContextItem[],
  settings: Settings,
  requester: Requester,
  now: number = Date.now(),
): boolean {
  return explainGate(input, items, settings, requester, now) === 'ok';
}

/** Same checks as `gate`, but says which one stopped the request. */
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
  const foreign = items.filter((i) => isForeign(i, requester));
  if (foreign.length === 0) return 'own-context';
  if (!foreign.some((i) => isFresh(i, now))) return 'stale-context';
  return 'ok';
}
