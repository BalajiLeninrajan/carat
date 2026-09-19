import type { ElementDescriptor, FieldDescriptor, InteractSuggestion, PageMeta } from './types';
import { PAGE_SOURCE } from './types';

/** Confidence of a click on the link whose site or title is what the user searched for. Above every level's floor. */
export const PAGE_QUERY_CONFIDENCE = 0.8;

export const QUERY_MAX = 80;

/** What the user searched for on the page being looked at, and the tokens it matches links by. */
export interface PageIntent {
  query: string;
  tokens: string[];
}

/**
 * The page's own query: what the content script read off the URL (`q`,
 * `query` or `search`) or a search field with text in it, else a described
 * search field that has a value. Null when the page has none, or when the
 * query has no word in it worth matching.
 */
export function pageIntent(page: PageMeta, fields: FieldDescriptor[] = []): PageIntent | null {
  const query = (page.query ?? '').trim() || fields.find((f) => f.v && looksLikeSearch(f))?.v?.trim() || '';
  const tokens = queryTokens(query);
  return tokens.length > 0 ? { query: query.slice(0, QUERY_MAX), tokens } : null;
}

const SEARCH_FIELD = /\bsearch\b/i;

function looksLikeSearch(f: FieldDescriptor): boolean {
  if (f.t === 'input:search' || f.t === 'searchbox' || f.nm === 'q') return true;
  return SEARCH_FIELD.test([f.nm, f.ph, f.al, f.lb].filter(Boolean).join(' '));
}

/** Lowercase words with punctuation stripped: "DoorDash!" and "door-dash" both become tokens without the marks. */
export function queryTokens(query: string): string[] {
  return normalizeForMatch(query)
    .split(' ')
    .filter((t) => t.length > 0);
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Second-level labels under which the registrable name sits one level deeper: bbc.co.uk, abc.com.au.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'ne', 'or']);

/**
 * The part of a host the user would recognise as the site: `doordash.com` for
 * `www.doordash.com`, `bbc.co.uk` for `news.bbc.co.uk`. Not the public suffix
 * list, just the common two-label country suffixes. Lowercase, no trailing dot.
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const keep = tld.length === 2 && SECOND_LEVEL.has(second) && labels.length >= 3 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** The site's own name inside its domain: `doordash` for `doordash.com`. */
export function domainLabel(domain: string): string {
  return domain.split('.')[0] ?? '';
}

const MIN_DOMAIN_TOKEN_CHARS = 4;

/**
 * The link is the result the user searched for: every query token appears as
 * a word in its name, or the tokens run together are the site's name (or sit
 * inside it, once they are long enough to mean something: "uber" in
 * `ubereats`, but not "me" in `meetup`).
 */
export function linkMatchesQuery(link: Pick<ElementDescriptor, 'nm' | 'h'>, intent: PageIntent): boolean {
  const { tokens } = intent;
  if (tokens.length === 0) return false;
  const name = ` ${normalizeForMatch(link.nm)} `;
  if (tokens.every((t) => name.includes(` ${t} `))) return true;
  if (!link.h) return false;
  const site = domainLabel(link.h);
  const joined = tokens.join('');
  return site === joined || (joined.length >= MIN_DOMAIN_TOKEN_CHARS && site.includes(joined));
}

const MIN_RELATED_TOKEN_CHARS = 3;

/**
 * The link has something to do with the query: at least one token of three
 * or more letters is a word in its name or part of its site's name. What the
 * model's fuzzy pick must at least satisfy; "weather" never opens doordash.com.
 */
export function linkRelatesToQuery(link: Pick<ElementDescriptor, 'nm' | 'h'>, intent: PageIntent): boolean {
  if (linkMatchesQuery(link, intent)) return true;
  const name = ` ${normalizeForMatch(link.nm)} `;
  const site = link.h ? domainLabel(link.h) : '';
  return intent.tokens.some((t) => t.length >= MIN_RELATED_TOKEN_CHARS && (name.includes(` ${t} `) || (site !== '' && site.includes(t))));
}

/** A described element is a real link: role `link` with a destination site. Anchors that act as buttons carry no `h`. */
export function isSiteLink(e: Pick<ElementDescriptor, 'r' | 'h'>): e is ElementDescriptor & { h: string } {
  return e.r === 'link' && typeof e.h === 'string' && e.h.length > 0;
}

/** The first described link, in the order the page lists them, that the query names. Null without a query or a match. */
export function firstMatchingLink(elements: ElementDescriptor[], intent: PageIntent | null): ElementDescriptor | null {
  if (!intent) return null;
  return elements.find((e) => isSiteLink(e) && linkMatchesQuery(e, intent)) ?? null;
}

/**
 * The click on the link the page's own query names: cited to the page, sure
 * enough for every eagerness level. Built the same way by the local provider
 * and by the orchestrator's pre-check, so both offer the same chip.
 */
export function pageQueryClick(link: ElementDescriptor, intent: PageIntent): InteractSuggestion {
  return {
    kind: 'interact',
    elementId: link.i,
    verb: 'click',
    value: link.nm,
    confidence: PAGE_QUERY_CONFIDENCE,
    reason: `you searched for "${intent.query}" on this page; this result is on ${link.h}`,
    sourceContextId: PAGE_SOURCE,
  };
}
