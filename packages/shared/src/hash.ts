import { normalizeWhitespace } from './truncate';

const OFFSET = 0x811c9dc5;
const PRIME = 0x01000193;

/** FNV-1a 32-bit over UTF-16 code units; result is unsigned. */
export function fnv1a(text: string): number {
  let h = OFFSET;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, PRIME);
  }
  return h >>> 0;
}

/** Hash used for ContextItem.hash: whitespace-collapsed, case-folded text. */
export function hashText(text: string): number {
  return fnv1a(normalizeWhitespace(text).toLowerCase());
}
