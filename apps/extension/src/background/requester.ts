import type { PageMeta } from '@carat/shared';

/** Who is asking for suggestions: the tab and origin whose own text must never be used. */
export interface Requester {
  tabId: number | undefined;
  origin: string;
}

export function requesterFromSender(sender: chrome.runtime.MessageSender, page: PageMeta): Requester {
  return { tabId: sender.tab?.id, origin: originOf(sender.origin ?? sender.url) ?? `https://${page.host}` };
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
