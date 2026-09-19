/** Stable identity for a field across enumerations: `tag|type|name|id|placeholder|ariaLabel`. */
export function fingerprintOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? (el as HTMLInputElement).type : '';
  return [
    tag,
    type,
    el.getAttribute('name') ?? '',
    el.id,
    placeholderOf(el) ?? '',
    el.getAttribute('aria-label') ?? '',
  ].join('|');
}

/**
 * Shared by the descriptor and the fingerprint so the background's
 * fingerprint-to-descriptor match sees the same placeholder in both.
 */
export function placeholderOf(el: Element): string | null {
  return el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? el.getAttribute('data-placeholder');
}
