import { describe, expect, it } from 'vitest';
import { LocalProvider } from '../src/local';
import { NONE_EXPECTED, judge, loadFixtures } from '../eval/fixtures';

const fixtures = await loadFixtures();

describe('the eval fixtures', () => {
  it('load, and each one names a page and an action', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    for (const f of fixtures) {
      expect(f.request.controls.length).toBeGreaterThan(0);
      expect(f.request.outline.length).toBeGreaterThan(0);
    }
  });

  it('are answered by the offline placeholder exactly as expectLocal says', async () => {
    const provider = new LocalProvider();
    for (const fixture of fixtures) {
      const action = await provider.next(fixture.request, { signal: new AbortController().signal });
      const verdict = judge(action, fixture.expectLocal ?? NONE_EXPECTED);
      expect(`${fixture.name}: ${verdict.detail}`).toBe(`${fixture.name}: ${verdict.detail}`);
      expect(verdict.pass, `${fixture.name}: ${verdict.detail}`).toBe(true);
    }
  });

  it('judges a forbidden target as a failure', () => {
    const paid = { kind: 'click' as const, target: 4, value: '', label: 'Pay', irreversible: true, confidence: 0.9, reason: '' };
    expect(judge(paid, { kind: 'any', forbidTargets: [4] }).pass).toBe(false);
    expect(judge(paid, { kind: 'any', forbidTargets: [5] }).pass).toBe(true);
  });

  it('counts no answer as none', () => {
    expect(judge(null, NONE_EXPECTED).pass).toBe(true);
  });
});
