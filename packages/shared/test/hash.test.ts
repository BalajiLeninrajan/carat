import { describe, expect, it } from 'vitest';
import { fnv1a, hashText } from '../src/hash';

describe('fnv1a', () => {
  it('matches the reference vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('is unsigned and stable', () => {
    const h = fnv1a('dinner at Seven Shores Cafe');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBe(fnv1a('dinner at Seven Shores Cafe'));
    expect(h).not.toBe(fnv1a('dinner at Seven Shores Caff'));
  });
});

describe('hashText', () => {
  it('ignores whitespace and case differences', () => {
    expect(hashText('Seven  Shores\nCafe')).toBe(hashText('seven shores cafe'));
    expect(hashText('Seven Shores Cafe')).not.toBe(hashText('Seven Shores'));
  });
});
