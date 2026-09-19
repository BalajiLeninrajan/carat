import type { PageKind, PageState } from '@carat/shared';
import { normalizeWhitespace, truncate } from '@carat/shared';
import { hasVisiblePasswordField } from '../capture/should-capture';
import { hasMoreBelow, viewportsOf } from '../scroll';
import { pageQuery } from './query';

/** The parts of `location` the kind detector reads; jsdom will not let a test move the real one. */
export type PageLocation = Pick<Location, 'host' | 'pathname' | 'search'>;

/** Accepted actions carried back to the provider; older ones fall off first. */
const MAX_DONE = 12;

const SEARCH_ENGINE = /(^|\.)(google|bing|duckduckgo|ecosia|startpage|brave|qwant|yandex|baidu|yahoo|kagi)\.[a-z.]{2,}$/i;
const SERP_PATH = /(^|\/)(search|results|s)(\/|$)/i;
const CHECKOUT_PATH = /(^|\/)(checkout|cart|basket|payment|billing|shipping|place-order|order)(\/|$)/i;

/** Text this long, under a reading landmark, is an article whatever else the page holds. */
const ARTICLE_CHARS = 1200;
/** Text this long is an article even with no landmark to hang it on. */
const LONG_CHARS = 3000;
/** A form with this many controls is what the page is for. */
const FORM_FIELDS = 3;
/** This many repeated articles, with no one of them dominating, is a feed. */
const FEED_ITEMS = 5;

const FORM_FIELD_SELECTOR =
  'input:not([type="hidden" i]):not([type="submit" i]):not([type="button" i]):not([type="reset" i]):not([type="image" i]),textarea,select';
const READING_LANDMARK = 'article,[role="article"],main,[role="main"]';

/**
 * The page as a whole, as the next-step predictor needs it: what kind of page
 * it is, how far down it the user has read, its own query, and what carat has
 * already done here. Undefined in a sub-frame, which never gets a chip.
 *
 * `done` is the content script's own record for this page load: element keys
 * (`role|name`) and `scroll`. It is the only part of the state the DOM does
 * not supply.
 */
export function pageStateOf(
  doc: Document,
  win: Window | null = doc.defaultView,
  done: readonly string[] = [],
  location: PageLocation = doc.location,
): PageState | undefined {
  if (!win || win.self !== win.top) return undefined;
  const { y, pages } = viewportsOf(win, doc);
  const state: PageState = { kind: pageKind(doc, location), y, pages, more: hasMoreBelow(win, doc) };
  const q = pageQuery(doc, location);
  if (q) state.q = q;
  if (done.length > 0) state.done = done.slice(-MAX_DONE);
  return state;
}

/**
 * URL first, then the DOM. A visible password field is a login page and gets
 * no prior at all. A checkout beats a plain form, a results page beats a
 * feed, and a reading landmark with real text beats everything left over.
 */
export function pageKind(doc: Document, location: PageLocation = doc.location): PageKind {
  if (hasVisiblePasswordField(doc)) return 'unknown';
  const { host, pathname } = location;
  if (CHECKOUT_PATH.test(pathname)) return 'checkout';
  if (isSearchApp(host, pathname)) return 'search-app';
  if (isSerp(doc, location)) return 'serp';
  if (isFeed(doc)) return 'feed';
  if (formFields(doc) >= FORM_FIELDS) return 'form';
  const text = readingText(doc);
  if (doc.querySelector(READING_LANDMARK) ? text >= ARTICLE_CHARS : text >= LONG_CHARS) return 'article';
  return 'unknown';
}

/** Apps whose point is one search or compose box; the plain fill logic already knows them. */
function isSearchApp(host: string, path: string): boolean {
  if (host === 'maps.google.com' || host === 'calendar.google.com' || host === 'mail.google.com') return true;
  if (!/(^|\.)google\.[a-z.]{2,}$/i.test(host)) return false;
  return path.startsWith('/maps') || path.startsWith('/travel') || path.startsWith('/flights');
}

/**
 * A search engine with a query, or any site whose path says search and which
 * answered with a list of links. Amazon's `/s?k=`, GitHub's `/search?q=` and
 * DuckDuckGo's bare `/?q=` all land here.
 */
function isSerp(doc: Document, location: PageLocation): boolean {
  if (!queryParam(location)) return false;
  if (SEARCH_ENGINE.test(location.host)) return true;
  return SERP_PATH.test(location.pathname) && doc.querySelectorAll('a[href]').length >= FEED_ITEMS;
}

function isFeed(doc: Document): boolean {
  if (doc.querySelector('[role="feed"]')) return true;
  return doc.querySelectorAll('article').length >= FEED_ITEMS;
}

function formFields(doc: Document): number {
  let most = 0;
  for (const form of doc.querySelectorAll('form')) most = Math.max(most, form.querySelectorAll(FORM_FIELD_SELECTOR).length);
  return most;
}

/** Characters under the page's reading landmark, or in the body when it has none. */
function readingText(doc: Document): number {
  const root = doc.querySelector(READING_LANDMARK) ?? doc.body;
  return normalizeWhitespace(root?.textContent ?? '').length;
}

function queryParam(location: PageLocation): string | undefined {
  const params = new URLSearchParams(location.search);
  for (const key of ['q', 'query', 'search_query', 'search', 'k', 'text', 'wd']) {
    const value = normalizeWhitespace(params.get(key) ?? '');
    if (value) return value.slice(0, 80);
  }
  return undefined;
}
