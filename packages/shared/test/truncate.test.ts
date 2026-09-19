import { describe, expect, it } from 'vitest';
import { normalizeWhitespace, truncate } from '../src/truncate';

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('clips to max length including the ellipsis', () => {
    const out = truncate('Seven Shores Cafe on Regina Street', 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles degenerate maxima', () => {
    expect(truncate('abc', 0)).toBe('');
    expect(truncate('abc', 1)).toBe('…');
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs and trims', () => {
    expect(normalizeWhitespace('  a \n\t b   c ')).toBe('a b c');
  });
});
