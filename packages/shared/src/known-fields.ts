import type { FieldDescriptor, IntentName, PageMeta } from './types';

/** A destination page whose fields are known before its DOM exists: the three intent sites plus Google search. */
export type KnownPageId = IntentName | 'search';

export interface KnownPage {
  id: KnownPageId;
  /** What the content script's PageMeta will say, minus the live title. */
  page: PageMeta;
  /**
   * The fields the content script is expected to describe on this page, in
   * the shape `enumerateFields` produces. Ids are relative to this list, not
   * to any live snapshot; `matchesKnownField` bridges the two.
   */
  fields: FieldDescriptor[];
  /** True when `url` is this page. Hosts match exactly; paths decide between Maps and search on www.google.com. */
  matches(url: URL): boolean;
  /** True when the URL already carries the value for the page's main field, so there is nothing empty to fill. */
  prefilled(url: URL): boolean;
}

const GOOGLE_HOSTS = new Set(['www.google.com', 'google.com']);

export const KNOWN_PAGES: readonly KnownPage[] = [
  {
    id: 'maps',
    page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' },
    fields: [{ i: 'f0', t: 'input:text', nm: 'searchboxinput', ph: 'Search Google Maps', al: 'Search Google Maps' }],
    matches: (url) => GOOGLE_HOSTS.has(url.host) && url.pathname.startsWith('/maps'),
    // A search deep link (`/maps/search/?query=`) or a place page shows the box already filled.
    prefilled: (url) => url.searchParams.has('query') || url.pathname.startsWith('/maps/place/'),
  },
  {
    id: 'calendar',
    page: { host: 'calendar.google.com', title: 'Google Calendar', path: '/calendar/u/0/r/eventedit' },
    fields: [
      { i: 'f0', t: 'input:text', al: 'Add title', ph: 'Add title' },
      { i: 'f1', t: 'input:text', al: 'Add location', ph: 'Add location', nb: 'Add location Add conferencing' },
      { i: 'f2', t: 'input:text', al: 'Start date' },
      { i: 'f3', t: 'input:text', al: 'Start time' },
    ],
    matches: (url) => url.host === 'calendar.google.com' && url.pathname.includes('/eventedit'),
    prefilled: (url) => url.searchParams.has('text'),
  },
  {
    id: 'gmail',
    page: { host: 'mail.google.com', title: 'Gmail', path: '/mail/u/0/' },
    fields: [
      { i: 'f0', t: 'combobox', nm: 'to', al: 'To recipients', nb: 'To Cc Bcc' },
      { i: 'f1', t: 'input:text', nm: 'subjectbox', ph: 'Subject', al: 'Subject' },
      { i: 'f2', t: 'ce', al: 'Message Body' },
    ],
    matches: (url) => url.host === 'mail.google.com',
    prefilled: (url) => url.searchParams.has('to'),
  },
  {
    id: 'search',
    page: { host: 'www.google.com', title: 'Google', path: '/' },
    fields: [{ i: 'f0', t: 'textarea', nm: 'q', al: 'Search', ac: 'off' }],
    // Only the empty home page; a results page shows the query typed in.
    matches: (url) => GOOGLE_HOSTS.has(url.host) && (url.pathname === '/' || url.pathname === '/webhp'),
    prefilled: (url) => url.searchParams.has('q'),
  },
];

/** The known page a full URL lands on, or undefined for every other page (and for a prefilled deep link). */
export function knownPageForUrl(url: string | URL, pages: readonly KnownPage[] = KNOWN_PAGES): KnownPage | undefined {
  let u: URL;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const page = pages.find((p) => p.matches(u));
  return page && !page.prefilled(u) ? page : undefined;
}

/** The known page behind a live snapshot's host and path, as the orchestrator sees them. */
export function knownPageFor(host: string, path: string): KnownPage | undefined {
  try {
    return KNOWN_PAGES.find((p) => p.matches(new URL(`https://${host}${path.startsWith('/') ? path : `/${path}`}`)));
  } catch {
    return undefined;
  }
}

const NAME_KEYS = ['nm', 'al', 'ph'] as const;

/**
 * Whether a field the content script described is the one a known page
 * promised: same control type, and the name, aria-label or placeholder agrees.
 * Live values are truncated to 40 or 60 chars; the known ones are shorter than
 * that, so equality after case folding is enough.
 */
export function matchesKnownField(known: FieldDescriptor, live: FieldDescriptor): boolean {
  if (known.t !== live.t) return false;
  return NAME_KEYS.some((k) => {
    const want = known[k];
    const got = live[k];
    return !!want && !!got && want.toLowerCase() === got.toLowerCase();
  });
}
