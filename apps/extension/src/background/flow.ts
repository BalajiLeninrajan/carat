import type { PageMeta } from '@carat/shared';

/**
 * Whether a stored task or entity list marks this page as a step in a flow
 * the user is partway through (a booking that started on Google Flights and
 * is now on the airline's site). That layer does not exist yet, so this is
 * false for every page; the click rules already read it, so plugging the
 * goal store in later changes nothing else. It must stay a pure function of
 * what the service worker knows: no page text, no network.
 */
export function flowActive(_page: PageMeta): boolean {
  return false;
}
