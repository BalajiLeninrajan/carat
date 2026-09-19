// Country-code suffixes that take a second label before they mean a site.
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);

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
