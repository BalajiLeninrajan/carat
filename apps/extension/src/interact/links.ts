import { isDenylisted, isDestructiveName, registrableDomain, truncate } from '@carat/shared';
import { isVisible } from '../capture/visibility';
import type { LinkCandidate } from '../fill/adapters';
import { getAdapter } from '../fill/adapters';
import { inViewport } from '../scroll';
import { pageQuery } from '../snapshot/query';
import { accessibleName } from './name';

/** Links are described only from the viewport down to this many screens below it. */
export const LINK_WINDOW_BELOW = 1;
export const MAX_LINKS = 8;

const NAME_MAX = 60;
// A short link named like an action ("Sign out", "Unsubscribe", "Delete account") is one; a page title that
// happens to contain "order now" is not, and following it orders nothing.
const ACTION_NAME_WORDS = 4;
// GET links that do something: never offered, whatever they are called.
const ACTION_PATH = /(?:^|[/_.-])(?:logout|log-out|signout|sign-out|unsubscribe|delete|remove|cancel|checkout|pay|payment|withdraw|transfer|deactivate)(?=$|[/_.?-])/i;
// Page chrome and cookie banners: not what anyone searched for.
const OUTSIDE_CONTENT = [
  'nav',
  '[role="navigation"]',
  'header',
  '[role="banner"]',
  'footer',
  '[role="contentinfo"]',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[aria-label*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
].join(',');
const INNER_TITLE = 'h1,h2,h3,h4';

export interface Site {
  host: string;
  path: string;
}

/** One real link worth describing: the anchor, its title, the element the chip sits on, and where it goes. */
export interface LinkEntry {
  el: HTMLAnchorElement;
  name: string;
  at: Element;
  /** Registrable domain of the destination: `doordash.com`. */
  site: string;
  inViewport: boolean;
  rect: DOMRect;
  order: number;
}

/**
 * Real links on the page, at most MAX_LINKS, in page order, and only while
 * the page has a query of its own: without one there is nothing to match a
 * link against, and the model is told to click none. A host adapter (Google,
 * DuckDuckGo, Bing) picks the result titles; anywhere else every `a[href]`
 * with visible text is a candidate. Out, before anything is described: links
 * to `mailto:`, `tel:` and `javascript:`, links on nav, header, footer or a
 * cookie banner, links to denylisted hosts or to a path that acts (logout,
 * unsubscribe, checkout), downloads, and short links with a destructive name.
 */
export function enumerateLinks(doc: Document, win: Window, site: Site): LinkEntry[] {
  if (!pageQuery(doc)) return [];
  const picked = getAdapter(site.host, site.path)?.links;
  const found = picked ? picked(doc) : genericLinks(doc);
  const vh = win.innerHeight;
  const out: LinkEntry[] = [];
  found.forEach(({ el, name, at }, order) => {
    if (out.length >= MAX_LINKS) return;
    const target = destination(el, doc);
    if (!target || el.hasAttribute('download') || el.closest(OUTSIDE_CONTENT)) return;
    const rect = at.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rect.bottom <= 0 || rect.top >= (1 + LINK_WINDOW_BELOW) * vh) return;
    if (!isVisible(el, win) || el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-hidden="true"],[inert]')) return;
    const title = truncate(name, NAME_MAX);
    if (!title || (isDestructiveName(title) && title.split(/\s+/).length <= ACTION_NAME_WORDS)) return;
    out.push({ el, name: title, at, site: target, inViewport: inViewport(at, win), rect, order });
  });
  return out;
}

/** The registrable domain the link goes to, or null when it is not an http(s) page carat may offer. */
function destination(el: HTMLAnchorElement, doc: Document): string | null {
  const href = el.getAttribute('href') ?? '';
  if (href === '' || href.startsWith('#')) return null;
  let url: URL;
  try {
    url = new URL(href, doc.baseURI);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || isDenylisted(url.hostname)) return null;
  if (ACTION_PATH.test(url.pathname)) return null;
  return registrableDomain(url.hostname);
}

/** Every anchor with an href, named by its aria-label, an inner heading, or its own text. Anchors acting as buttons are elements already. */
function genericLinks(doc: Document): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  for (const el of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (el.getAttribute('role')?.toLowerCase() === 'button') continue;
    const heading = el.getAttribute('aria-label') ? null : el.querySelector(INNER_TITLE);
    const name = heading ? (heading.textContent ?? '').replace(/\s+/g, ' ').trim() : accessibleName(el, doc);
    if (!name) continue;
    out.push({ el, name, at: el });
  }
  return out;
}
