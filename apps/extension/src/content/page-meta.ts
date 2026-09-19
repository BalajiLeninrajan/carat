import type { PageMeta } from '@carat/shared';
import { LIMITS, normalizeWhitespace, truncate } from '@carat/shared';
import { pageQuery } from '../snapshot/query';

export function pageMeta(doc: Document): PageMeta {
  const meta: PageMeta = {
    host: doc.location.host,
    title: truncate(normalizeWhitespace(doc.title), LIMITS.titleChars),
    path: doc.location.pathname,
  };
  const h1 = normalizeWhitespace(doc.querySelector('h1')?.textContent ?? '');
  if (h1) meta.h1 = truncate(h1, LIMITS.titleChars);
  const query = pageQuery(doc);
  if (query) meta.query = query;
  return meta;
}
