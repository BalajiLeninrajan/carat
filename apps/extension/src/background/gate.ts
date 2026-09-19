import type { ContextItem, Eagerness, ElementDescriptor, FieldDescriptor, PageMeta, Settings } from '@carat/shared';
import { CONTROL_ROLES, DEFAULT_EAGERNESS, clickAllowed, isDenylisted } from '@carat/shared';
import { isSiteOff } from '../store';
import type { GateVerdict } from './diag';
import { isFresh, isSource } from './eligible';
import type { Requester } from './requester';
import { ownContext } from './score';

export interface GateInput {
  page: PageMeta;
  fields: FieldDescriptor[];
  elements?: ElementDescriptor[];
  /** Context ids behind carat's own recent fills on this tab. */
  filled?: string[];
  /** A stored task marks this page as a step in an ongoing flow. */
  flow?: boolean;
}

/**
 * Whether a request is worth a provider call: something to act on, and either
 * other tabs' text or the page's own. A field always counts. A checkbox,
 * slider, select or option card counts, since another tab may name its
 * value. Plain buttons count only once carat has filled something here, or
 * when the page's primary action may be clicked without that (a flow, or
 * the eager level with nothing left to fill); nothing in another tab says
 * which other button to press on a page the user just opened.
 */
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
 * from another tab feeds fills and interactions (another origin too, below
 * eager); the requesting tab's own fresh text feeds actions. Either is enough
 * to ask.
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
  if (!hasWork(input, settings.eagerness)) return 'no-fields';
  if (items.length === 0) return 'no-context';
  const fresh = items.filter((i) => isFresh(i, now));
  if (fresh.length === 0) return 'stale-context';
  if (fresh.some((i) => isSource(i, requester, settings.eagerness))) return 'ok';
  if (ownContext(items, requester, now).length > 0) return 'ok';
  // Fresh text exists but is neither another site's nor this tab's own: another tab on the same site, shut out below eager.
  return 'own-context';
}

/** A field, a value-bearing control, (after a fill here) any element at all, or a primary action the click rule lets through. */
export function hasWork(input: GateInput, eagerness: Eagerness = DEFAULT_EAGERNESS): boolean {
  if (input.fields.length > 0) return true;
  const elements = input.elements ?? [];
  if (elements.some((e) => CONTROL_ROLES.has(e.r))) return true;
  const filled = (input.filled?.length ?? 0) > 0;
  if (filled && elements.length > 0) return true;
  const gate = { filled, flow: input.flow === true, eagerness, fillable: false };
  return elements.some((e) => (e.r === 'button' || e.r === 'link') && e.m !== 1 && clickAllowed(e, gate));
}
