/** A link a host adapter picked out: the anchor to click, its title, and the element the chip sits on. */
export interface LinkCandidate {
  el: HTMLAnchorElement;
  name: string;
  /** The result's title element, when the anchor wraps more than the title. */
  at: Element;
}

export interface HostAdapter {
  preferredSelector?: string;
  fallbackSelectors?: string[];
  postFill?: (el: Element) => void;
  /** Result links on a search page, in page order, in place of the generic anchor scan. */
  links?: (doc: Document) => LinkCandidate[];
}

const MAPS: HostAdapter = {
  preferredSelector: '#searchboxinput',
  fallbackSelectors: ['input[aria-label="Search Google Maps"]', '#searchbox input[role=combobox]'],
};

const CALENDAR: HostAdapter = {
  // Calendar's date/time inputs only commit on Enter; a typed value alone is
  // discarded when the field blurs.
  postFill(el) {
    if (!isTimeLike(el)) return;
    for (const type of ['keydown', 'keyup'] as const) {
      el.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }),
      );
    }
  },
};

const GOOGLE_SEARCH: HostAdapter = {
  preferredSelector: 'textarea[name=q]',
  fallbackSelectors: ['input[name=q]'],
  links: serpLinks,
};

const SERP: HostAdapter = { links: serpLinks };

export const ADAPTERS: Record<string, HostAdapter> = {
  'maps.google.com': MAPS,
  'calendar.google.com': CALENDAR,
  'www.google.com': GOOGLE_SEARCH,
  'duckduckgo.com': SERP,
  'www.bing.com': SERP,
  'bing.com': SERP,
};

const GOOGLE_HOST = /(^|\.)google\.[a-z.]+$/;

export function getAdapter(host: string, path = currentPath()): HostAdapter | undefined {
  if (GOOGLE_HOST.test(host) && path.startsWith('/maps')) return MAPS;
  if (GOOGLE_HOST.test(host) && path.startsWith('/search')) return GOOGLE_SEARCH;
  return ADAPTERS[host];
}

const RESULT_HEADINGS = 'h1,h2,h3';
// Google's knowledge panel and right-hand column; result titles never sit there.
const NOT_A_RESULT = '#rhs,[data-attrid],[role="complementary"]';

/**
 * Result links on Google, DuckDuckGo and Bing: each result's title is a
 * heading inside its anchor (Google) or an anchor inside its heading
 * (DuckDuckGo, Bing), and the anchor points off the search site. That last
 * rule is what skips "People also ask", image packs, video tabs and the
 * knowledge panel, whose links all stay on the search host.
 */
export function serpLinks(doc: Document): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  const seen = new Set<Element>();
  for (const heading of doc.querySelectorAll(RESULT_HEADINGS)) {
    if (heading.closest(NOT_A_RESULT)) continue;
    const el = heading.closest<HTMLAnchorElement>('a[href]') ?? heading.querySelector<HTMLAnchorElement>('a[href]');
    if (!el || seen.has(el)) continue;
    let host: string;
    try {
      host = new URL(el.getAttribute('href') ?? '', doc.baseURI).host;
    } catch {
      continue;
    }
    if (!host || host === doc.location.host || sameSearchSite(host, doc.location.host)) continue;
    const name = (heading.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    seen.add(el);
    out.push({ el, name, at: heading });
  }
  return out;
}

// google.com results link to google.com/maps, translate.google.com and the like; none of them is the result the user searched for.
function sameSearchSite(host: string, pageHost: string): boolean {
  const tail = pageHost.replace(/^www\./, '');
  return host === tail || host.endsWith(`.${tail}`);
}

/**
 * The snapshot may have registered a decoy (Maps renders a second, hidden
 * search input); when the adapter names the real one and it is on the page,
 * fill that instead. A focused registry element is left alone: the user
 * chose it.
 */
export function resolveTarget(
  host: string,
  registryEl: Element | null,
  path = currentPath(),
): Element | null {
  const adapter = getAdapter(host, path);
  if (!adapter) return registryEl;

  const doc = registryEl?.ownerDocument ?? document;
  if (registryEl && registryEl.isConnected && doc.activeElement === registryEl) return registryEl;

  const selectors = [adapter.preferredSelector, ...(adapter.fallbackSelectors ?? [])].filter(
    (s): s is string => typeof s === 'string',
  );
  for (const selector of selectors) {
    const found = doc.querySelector(selector);
    if (found) return found;
  }
  return registryEl;
}

function isTimeLike(el: Element): boolean {
  const hints = [
    el.getAttribute('aria-label'),
    el.getAttribute('name'),
    el.getAttribute('placeholder'),
    el.getAttribute('data-key'),
  ];
  return hints.some((h) => h !== null && /\b(time|date)\b/i.test(h));
}

function currentPath(): string {
  return typeof location === 'undefined' ? '' : location.pathname;
}
