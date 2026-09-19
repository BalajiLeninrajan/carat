/** True when a context item came from the host being filled; that page is never its own source. */
export function sameSite(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return origin === host;
  }
}
