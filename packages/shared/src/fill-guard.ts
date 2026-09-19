import type { FieldDescriptor, PageMeta } from './types';
import { normalizeWhitespace } from './truncate';

/**
 * The page's own text is a fill source now, which means a field can be filled
 * with the page's furniture unless something stops it. This is that
 * something, and every provider and the service worker check it.
 */

/** Containment only counts once a string is this long; a `name` of "q" must not match every value holding a q. */
const MIN_ECHO = 4;

/** Interface words that are never anybody's answer, however they are dressed up. */
const CHROME_WORD =
  /^(?:search|search\s+\w+|menu|home|sign in|log ?in|sign up|settings|options|more|back|next|previous|close|open|share|subscribe|follow|help|about|contact|account|profile|notifications|messages|untitled|loading|advertisement|skip to (?:main )?content)$/i;

const norm = (s: string | undefined | null): string => normalizeWhitespace(s ?? '').toLowerCase();

function echoes(value: string, part: string | undefined): boolean {
  const t = norm(part);
  const v = norm(value);
  if (!t || !v) return false;
  if (t === v) return true;
  return t.length >= MIN_ECHO && v.length >= MIN_ECHO && (t.includes(v) || v.includes(t));
}

/** The value is the field reading itself back: its label, placeholder, aria-label, name or current value. */
export function echoesField(value: string, field: Pick<FieldDescriptor, 'lb' | 'ph' | 'al' | 'nm' | 'v'>): boolean {
  return [field.lb, field.ph, field.al, field.nm, field.v].some((part) => echoes(value, part));
}

/** The value is the page's own chrome: its title, its heading or its host. */
export function echoesPage(value: string, page: Pick<PageMeta, 'title' | 'h1' | 'host'>): boolean {
  const v = norm(value);
  if (!v) return true;
  for (const part of [page.title, page.h1]) {
    const t = norm(part);
    if (t && (t === v || (v.length >= MIN_ECHO && t.includes(v)))) return true;
  }
  const host = norm(page.host).replace(/^www\./, '');
  return host.length >= MIN_ECHO && (host === v || host.replace(/\.[a-z.]+$/, '') === v);
}

/**
 * Whether this value must not go in this field. A value that reads back the
 * field's own label, placeholder or current value is out whatever tab it came
 * from, and so is a bare interface word. A value taken from the page being
 * filled is out as well when it is that page's title, heading or host: the
 * point of reading the page is the restaurant somebody named in the thread,
 * never the thread's own furniture.
 */
export function refusesFill(
  value: string,
  field: Pick<FieldDescriptor, 'lb' | 'ph' | 'al' | 'nm' | 'v'>,
  page: Pick<PageMeta, 'title' | 'h1' | 'host'>,
  fromThisPage: boolean,
): boolean {
  if (norm(value).length === 0) return true;
  if (CHROME_WORD.test(norm(value))) return true;
  if (echoesField(value, field)) return true;
  return fromThisPage && echoesPage(value, page);
}
