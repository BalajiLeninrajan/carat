/** Key under which a (context, host, field) triple is remembered as consumed or dismissed. */
export function suppressionKey(contextId: string, host: string, fingerprint: string): string {
  return `${contextId}:${host}:${fingerprint}`;
}

/** Prefix shared by every suppression key for one context item on one host. */
export function suppressionPrefix(contextId: string, host: string): string {
  return `${contextId}:${host}:`;
}

const NAV = 'nav';

/**
 * Navigation is remembered by destination and entity rather than by context
 * item: the page item behind it gets a new id every time the chat scrolls, and
 * an errand done from one site is done from every site.
 */
export function navSuppressionKey(intent: string, value: string): string {
  return suppressionKey(NAV, '*', `${intent}|${value.replace(/\s+/g, ' ').trim().toLowerCase()}`);
}
