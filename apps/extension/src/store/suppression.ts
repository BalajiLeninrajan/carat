/** Key under which a (context, host, field) triple is remembered as consumed or dismissed. */
export function suppressionKey(contextId: string, host: string, fingerprint: string): string {
  return `${contextId}:${host}:${fingerprint}`;
}

/** Prefix shared by every suppression key for one context item on one host. */
export function suppressionPrefix(contextId: string, host: string): string {
  return `${contextId}:${host}:`;
}
