import { QUERY_MAX, normalizeWhitespace, truncate } from '@carat/shared';
import { hasVisiblePasswordField } from '../capture/should-capture';
import type { PageLocation } from './page-state';

const QUERY_PARAMS = ['q', 'query', 'search_query', 'search', 'k', 'text', 'wd'];
const SEARCH_FIELDS = 'input[type="search" i],[role="searchbox"],input[name="q"],textarea[name="q"],input[name*="search" i],input[aria-label*="search" i]';

/**
 * What the user searched for on this page: a `q`-style URL parameter, else
 * the text in a search field. The only place the query is read off the DOM:
 * the page state carries it from here into the request, and `pageIntent`
 * turns it into tokens. Never on a page with a visible password field, where
 * the search box may sit next to a login form and nothing from the page
 * should steer a click.
 */
export function pageQuery(doc: Document, location: Pick<PageLocation, 'search'> = doc.location): string {
  if (hasVisiblePasswordField(doc)) return '';
  const params = new URLSearchParams(location.search);
  for (const name of QUERY_PARAMS) {
    const value = normalizeWhitespace(params.get(name) ?? '');
    if (value) return truncate(value, QUERY_MAX);
  }
  for (const el of doc.querySelectorAll<HTMLElement>(SEARCH_FIELDS)) {
    const value = normalizeWhitespace('value' in el && typeof el.value === 'string' ? el.value : (el.textContent ?? ''));
    if (value) return truncate(value, QUERY_MAX);
  }
  return '';
}
