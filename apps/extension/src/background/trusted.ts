import type { Settings } from '@carat/shared';

/**
 * Only the extension's own pages (options, popup) may read or change settings
 * and browse the context store. Content scripts share the extension id, so the
 * sender's page URL is what tells them apart. `base` is
 * `chrome.runtime.getURL('')`, i.e. `chrome-extension://<id>/`. Compared as a
 * string: `new URL(...).origin` is "null" for this scheme outside Chrome.
 */
export function isExtensionPage(sender: chrome.runtime.MessageSender, base: string): boolean {
  if (!base.endsWith('/')) base += '/';
  if (sender.url) return sender.url.startsWith(base);
  return sender.origin !== undefined && `${sender.origin}/` === base;
}

/** What a content script may learn about settings: everything but the keys. */
export function redactSettings(settings: Settings): Settings {
  return { ...settings, apiKey: '', cfApiToken: '' };
}
