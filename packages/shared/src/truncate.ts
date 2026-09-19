const ELLIPSIS = '…';

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Clip to at most `max` UTF-16 units, ending in an ellipsis when clipped. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max === 1) return ELLIPSIS;
  return text.slice(0, max - 1).trimEnd() + ELLIPSIS;
}
