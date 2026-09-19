export interface HostAdapter {
  preferredSelector?: string;
  fallbackSelectors?: string[];
  postFill?: (el: Element) => void;
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
};

export const ADAPTERS: Record<string, HostAdapter> = {
  'maps.google.com': MAPS,
  'calendar.google.com': CALENDAR,
  'www.google.com': GOOGLE_SEARCH,
};

export function getAdapter(host: string, path = currentPath()): HostAdapter | undefined {
  if (/(^|\.)google\.[a-z.]+$/.test(host) && path.startsWith('/maps')) return MAPS;
  return ADAPTERS[host];
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
