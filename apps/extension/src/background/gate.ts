import type { ContextItem, FieldDescriptor, PageMeta, Settings } from '@carat/shared';
import { isDenylisted } from '@carat/shared';
import { isSiteOff } from '../store';
import { eligibleContext } from './eligible';
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
  if (!settings.enabled) return false;
  if (isSiteOff(settings, input.page.host)) return false;
  if (isDenylisted(input.page.host)) return false;
  if (input.fields.length === 0) return false;
  return eligibleContext(items, requester, now).length > 0;
}
