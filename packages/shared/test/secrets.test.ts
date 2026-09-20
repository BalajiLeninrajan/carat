import { describe, expect, it } from 'vitest';
import { looksSecret } from '../src/secrets';

describe('looksSecret', () => {
  it('catches card numbers, spaced or not', () => {
    expect(looksSecret('4539 1488 0343 6467')).toBe(true);
    expect(looksSecret('4539148803436467')).toBe(true);
    expect(looksSecret('3782-822463-10005')).toBe(true);
  });

  it('catches keys and tokens by their prefix', () => {
    expect(looksSecret('sk-proj-1a2b3c4d5e6f7g8h')).toBe(true);
    expect(looksSecret('ghp_16C7e42F292c69C2e7C9')).toBe(true);
    expect(looksSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('catches a one-word password and a long opaque run', () => {
    expect(looksSecret('Tr0ub4dor&3')).toBe(true);
    expect(looksSecret('aG93IG5vdyBicm93biBjb3cx')).toBe(true);
  });

  it('leaves ordinary text alone, including text with numbers in it', () => {
    for (const ok of [
      'Seven Shores Cafe',
      '10 Regina St N, Waterloo',
      'Dinner at Seven Shores Cafe on Friday at 6',
      'order NW-55821',
      'dana.lee@acme.com',
      '2026-09-18T18:00',
      '',
    ]) {
      expect(looksSecret(ok)).toBe(false);
    }
  });
});
