import { describe, expect, it } from 'vitest';
import { DEFAULT_EAGERNESS, EAGERNESS, EAGERNESS_LEVELS, isEagerness, weakBelow } from '../src/eagerness';
import { DEFAULT_SETTINGS } from '../src/types';

describe('EAGERNESS', () => {
  it('defaults to eager', () => {
    expect(DEFAULT_EAGERNESS).toBe('eager');
    expect(DEFAULT_SETTINGS.eagerness).toBe('eager');
  });

  it('loosens every knob monotonically from conservative to eager', () => {
    const [c, b, e] = EAGERNESS_LEVELS.map((l) => EAGERNESS[l]);
    expect(c!.minConfidence).toBeGreaterThan(b!.minConfidence);
    expect(b!.minConfidence).toBeGreaterThan(e!.minConfidence);
    expect(c!.jevGateMin).toBeGreaterThan(b!.jevGateMin);
    expect(b!.jevGateMin).toBeGreaterThan(e!.jevGateMin);
    expect(c!.maxSuggestions).toBeLessThanOrEqual(b!.maxSuggestions);
    expect(b!.maxSuggestions).toBeLessThan(e!.maxSuggestions);
    expect(c!.sameOriginContext).toBe(false);
    expect(e!.sameOriginContext).toBe(true);
    expect(c!.looseNames).toBe(false);
    expect(e!.looseNames).toBe(true);
    expect(c!.priorMin).toBeGreaterThan(b!.priorMin);
    expect(b!.priorMin).toBeGreaterThan(e!.priorMin);
  });

  it('lets the priors through by level: none at conservative, the first result and Continue at balanced, the scroll too at eager', () => {
    const serp = 0.8;
    const checkout = 0.7;
    const scroll = 0.55;
    expect(EAGERNESS.conservative.priorMin).toBeGreaterThan(1);
    expect(serp).toBeGreaterThanOrEqual(EAGERNESS.balanced.priorMin);
    expect(checkout).toBeGreaterThanOrEqual(EAGERNESS.balanced.priorMin);
    expect(scroll).toBeLessThan(EAGERNESS.balanced.priorMin);
    expect(scroll).toBeGreaterThanOrEqual(EAGERNESS.eager.priorMin);
  });

  it('keeps the old numbers as conservative', () => {
    expect(EAGERNESS.conservative).toMatchObject({ minConfidence: 0.7, maxSuggestions: 2 });
    expect(EAGERNESS.eager).toMatchObject({ minConfidence: 0.35, jevGateMin: 0.25, maxSuggestions: 4 });
  });

  it('says what weak means at each level: under the next stricter floor', () => {
    expect(weakBelow('eager')).toBe(EAGERNESS.balanced.minConfidence);
    expect(weakBelow('balanced')).toBe(EAGERNESS.conservative.minConfidence);
    expect(weakBelow('conservative')).toBe(0);
  });

  it('recognises the three level names and nothing else', () => {
    for (const l of EAGERNESS_LEVELS) expect(isEagerness(l)).toBe(true);
    expect(isEagerness('EAGER')).toBe(false);
    expect(isEagerness(undefined)).toBe(false);
  });
});
