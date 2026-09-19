import type { FieldDescriptor } from '@carat/shared';

/**
 * Feedback carries the content script's fingerprint
 * (`tag|type|name|id|placeholder|ariaLabel`); the background only has the
 * descriptor. Match the two loosely, tolerating the descriptor's truncation.
 * Unknown formats match, since suppressing too much is the safer failure.
 */
export function fingerprintMatchesDescriptor(fingerprint: string, d: FieldDescriptor): boolean {
  const parts = fingerprint.split('|');
  if (parts.length < 6) return true;
  const [tag = '', , name = '', id = '', placeholder = '', ariaLabel = ''] = parts;

  const [dTag] = d.t.split(':');
  if ((dTag === 'input' || dTag === 'textarea') && tag.toLowerCase() !== dTag) return false;

  if (d.nm && !(loose(d.nm, name) || loose(d.nm, id))) return false;
  if (d.ph && !loose(d.ph, placeholder)) return false;
  if (d.al && !loose(d.al, ariaLabel)) return false;
  if (!d.nm && !d.ph && !d.al) return !name && !id && !placeholder && !ariaLabel;
  return true;
}

function loose(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, ' ').trim();
  const y = b.replace(/\s+/g, ' ').trim();
  if (x.endsWith('…')) return y.startsWith(x.slice(0, -1));
  if (y.endsWith('…')) return x.startsWith(y.slice(0, -1));
  return x === y;
}
