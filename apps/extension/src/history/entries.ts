import { normalizeWhitespace, truncate } from '@carat/shared';
import { relativeAge } from '../format/age';

export const HISTORY_LIMITS = {
  /** Entries kept per tab; the oldest go first. */
  maxEntries: 30,
  /** Nothing older than this is kept or rendered. */
  ttlMs: 30 * 60_000,
  /** Lines the request carries. */
  maxLines: 12,
  /** How much of a typed value is remembered. */
  valueChars: 24,
  nameChars: 60,
  /** A URL in a navigation line: host plus path, no query. */
  urlChars: 80,
} as const;

/** How a navigation happened, as `webNavigation.onCommitted` reports it. */
export type NavHow = 'typed' | 'link' | 'form_submit' | 'reload' | 'back_forward' | 'other';

/**
 * Chrome reports a back or forward step as a qualifier on some other
 * transition type, so the qualifiers are read first.
 */
export function asNavHow(transition: string | undefined, qualifiers: readonly string[] = []): NavHow {
  if (qualifiers.includes('forward_back')) return 'back_forward';
  switch (transition) {
    case 'typed':
    case 'auto_bookmark':
    case 'generated':
    case 'keyword':
      return 'typed';
    case 'link':
    case 'auto_toplevel':
      return 'link';
    case 'form_submit':
      return 'form_submit';
    case 'reload':
      return 'reload';
    default:
      return 'other';
  }
}

/**
 * One thing that happened in a tab. `t` is when, in epoch milliseconds; every
 * other field is already redacted and truncated by whoever recorded it, since
 * this is what goes to the model.
 */
export type HistoryEntry =
  | { t: number; kind: 'click'; role: string; name: string }
  | { t: number; kind: 'type'; name: string; value: string }
  | { t: number; kind: 'nav'; how: NavHow; to: string }
  | { t: number; kind: 'opened'; from: number }
  | { t: number; kind: 'accepted'; what: string }
  | { t: number; kind: 'dismissed'; what: string }
  | { t: number; kind: 'snoozed' };

/**
 * One line of the timeline, without its age: `clicked button "Add to cart"`,
 * `typed into "Search" ("moms pan")`, `followed a link to shop.example/cart`.
 */
export function describeEntry(e: HistoryEntry): string {
  switch (e.kind) {
    case 'click':
      return `clicked ${e.role} ${quote(e.name)}`;
    case 'type':
      return e.value ? `typed into ${quote(e.name)} (${quote(e.value)})` : `typed into ${quote(e.name)}`;
    case 'nav':
      return navLine(e.how, e.to);
    case 'opened':
      return `opened from tab ${e.from}`;
    case 'accepted':
      return `accepted suggestion: ${e.what}`;
    case 'dismissed':
      return `dismissed suggestion: ${e.what}`;
    case 'snoozed':
      return 'snoozed for a minute';
  }
}

function navLine(how: NavHow, to: string): string {
  switch (how) {
    case 'link':
      return `followed a link to ${to}`;
    case 'typed':
      return `typed the address ${to}`;
    case 'form_submit':
      return `submitted a form to ${to}`;
    case 'reload':
      return `reloaded ${to}`;
    case 'back_forward':
      return `went back to ${to}`;
    case 'other':
      return `went to ${to}`;
  }
}

/**
 * The last `max` entries as the request carries them, oldest first, each
 * prefixed with its age: `40s ago: clicked button "Add to cart"`. Anything
 * past the TTL is left out, whatever the store still holds.
 */
export function renderHistory(
  entries: readonly HistoryEntry[],
  now: number,
  max: number = HISTORY_LIMITS.maxLines,
): string[] {
  return entries
    .filter((e) => now - e.t < HISTORY_LIMITS.ttlMs)
    .slice(-max)
    .map((e) => `${relativeAge(e.t, now)}: ${describeEntry(e)}`);
}

/** Host and path of a navigation target, without the query, which carries ids and tokens. */
export function navTarget(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const path = u.pathname === '/' ? '' : u.pathname;
    return truncate(`${u.host}${path}`, HISTORY_LIMITS.urlChars);
  } catch {
    return undefined;
  }
}

export function shortName(name: string): string {
  return truncate(normalizeWhitespace(name), HISTORY_LIMITS.nameChars);
}

export function shortValue(value: string): string {
  return truncate(normalizeWhitespace(value), HISTORY_LIMITS.valueChars);
}

function quote(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}
