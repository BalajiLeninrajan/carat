import type { PageMeta, PageState } from '@carat/shared';

/**
 * Whether this page is a step in a flow the user is partway through, which is
 * what lets its primary action be clicked with nothing filled, at any level.
 * Two things say so today, both from the page state the content script sent:
 * a checkout page, which is a step by definition, and a form carat itself
 * filled something on during this page load. The stored-task layer (a booking
 * that started on Google Flights and is now on the airline's site) hangs off
 * the same seam and needs no caller to change. It must stay a pure function
 * of what the service worker knows: no page text, no network.
 */
export function flowActive(_page: PageMeta, state?: PageState, filledHere = false): boolean {
  if (!state) return false;
  if (state.kind === 'checkout') return true;
  return state.kind === 'form' && filledHere;
}
