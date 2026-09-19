import type { ElementDescriptor, FieldDescriptor, PageMeta, PageState, Settings } from '@carat/shared';
import { isDenylisted } from '@carat/shared';
import { isSiteOff } from '../store';
import type { GateVerdict } from './diag';

export interface GateInput {
  page: PageMeta;
  fields: FieldDescriptor[];
  elements?: ElementDescriptor[];
  /** The page's kind, query and scroll position. Older content scripts send none. */
  state?: PageState;
  /** Context ids behind carat's own recent fills on this tab. */
  filled?: string[];
  /** A stored task, or the page state, marks this page as a step in an ongoing flow. */
  flow?: boolean;
}

/**
 * Whether a request is worth a provider call. Carat predicts the next action
 * on the page the user is on, so the bar is a snapshot and a host it may act
 * on: text from another tab is one input, not a precondition. The denylist,
 * the per-site switch and the global switch all still stop it, and a page
 * with a visible password field comes back `unknown` from the kind detector,
 * so it carries no prior of its own.
 */
export function gate(input: GateInput, settings: Settings): boolean {
  return explainGate(input, settings) === 'ok';
}

/** Same checks as `gate`, but says which one stopped the request. */
export function explainGate(input: GateInput, settings: Settings): GateVerdict {
  if (!settings.enabled) return 'disabled';
  if (isSiteOff(settings, input.page.host)) return 'site-off';
  if (isDenylisted(input.page.host)) return 'denylisted';
  if (!hasWork(input)) return 'no-snapshot';
  return 'ok';
}

/**
 * Something to answer about: a page state, which is enough on its own now
 * that the page itself can be the next step, or a field or element from a
 * content script too old to send one.
 */
export function hasWork(input: GateInput): boolean {
  if (input.state) return true;
  return input.fields.length > 0 || (input.elements?.length ?? 0) > 0;
}
