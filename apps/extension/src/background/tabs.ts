import type { OpenTab } from '@carat/shared';
import { LIMITS, isDenylisted, normalizeWhitespace, truncate } from '@carat/shared';

/** The slice of a `chrome.tabs.Tab` the request needs. */
export interface RawTab {
  id?: number;
  url?: string;
  title?: string;
}

/**
 * The tabs the user could switch to, as the request describes them: an id, a
 * host and a title. A denylisted host, a `chrome://` page and the requesting
 * tab itself are left out, and so is a tab with no id to switch to.
 */
export function describeTabs(tabs: readonly RawTab[], exclude?: number): OpenTab[] {
  const out: OpenTab[] = [];
  const seen = new Set<number>();
  for (const tab of tabs) {
    if (tab.id === undefined || tab.id === exclude || seen.has(tab.id)) continue;
    const host = hostOf(tab.url);
    if (!host || isDenylisted(host)) continue;
    seen.add(tab.id);
    out.push({ id: tab.id, host, title: truncate(normalizeWhitespace(tab.title ?? ''), LIMITS.titleChars) });
  }
  return out;
}

/** Every open tab, described. The one place the request's `tabs` comes from. */
export async function describedTabs(exclude?: number): Promise<OpenTab[]> {
  return describeTabs(await chrome.tabs.query({}), exclude);
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : undefined;
  } catch {
    return undefined;
  }
}
