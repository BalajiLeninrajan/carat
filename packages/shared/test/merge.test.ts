import { describe, expect, it } from 'vitest';
import { mergeSuggestions } from '../src/merge';
import type { ActionSuggestion, FillSuggestion, InteractSuggestion } from '../src/types';

const s = (fieldId: string, value: string, confidence: number): FillSuggestion => ({
  kind: 'fill',
  fieldId,
  value,
  confidence,
  reason: '',
  sourceContextId: 'c1',
});
const ix = (elementId: string, value: string, confidence: number): InteractSuggestion => ({
  kind: 'interact',
  elementId,
  verb: 'click',
  value,
  confidence,
  reason: '',
  sourceContextId: 'c1',
});
const act = (value: string, confidence: number): ActionSuggestion => ({
  kind: 'action',
  intent: 'maps',
  value,
  when: '',
  location: '',
  confidence,
  reason: '',
  sourceContextId: 'o1',
});

describe('mergeSuggestions', () => {
  it('lets a surer incoming answer replace the current one per field, keeps the rest, sorts best first', () => {
    const fast = [s('f0', 'Seven Shores', 0.8), s('f1', 'Friday', 0.75)];
    const smart = [s('f0', 'Seven Shores Cafe', 0.92), s('f2', '10 Regina St N', 0.85)];
    expect(mergeSuggestions(fast, smart).map((x) => [x.kind === 'fill' ? x.fieldId : '', x.value])).toEqual([
      ['f0', 'Seven Shores Cafe'],
      ['f2', '10 Regina St N'],
      ['f1', 'Friday'],
    ]);
  });

  it('keeps the current answer on a tie or a lower confidence, by identity', () => {
    const cur = s('f0', 'Seven Shores', 0.8);
    expect(mergeSuggestions([cur], [s('f0', 'Other', 0.8)])[0]).toBe(cur);
    expect(mergeSuggestions([cur], [s('f0', 'Other', 0.7)])[0]).toBe(cur);
    expect(mergeSuggestions([], [])).toEqual([]);
  });

  it('merges interactions per element and never takes an action from the smart answer', () => {
    const cur = [ix('e0', 'Save', 0.8), act('Seven Shores Cafe', 0.8)];
    const out = mergeSuggestions(cur, [ix('e0', 'Save', 0.9), ix('e1', 'All day', 0.85), act('Other', 0.99)]);
    expect(out.map((x) => [x.kind, x.value, x.confidence])).toEqual([
      ['interact', 'Save', 0.9],
      ['interact', 'All day', 0.85],
      ['action', 'Seven Shores Cafe', 0.8],
    ]);
  });
});
