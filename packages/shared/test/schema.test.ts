import { describe, expect, it } from 'vitest';
import { SUGGESTION_JSON_SCHEMA, SuggestionListSchema } from '../src/schema';

const good = {
  suggestions: [
    {
      fieldId: 'f0',
      value: 'Seven Shores Cafe',
      confidence: 0.92,
      reason: 'place name from Discord',
      sourceContextId: 'c1',
    },
  ],
};

describe('SuggestionListSchema', () => {
  it('accepts a well-formed list and an empty list', () => {
    expect(SuggestionListSchema.parse(good)).toEqual(good);
    expect(SuggestionListSchema.parse({ suggestions: [] })).toEqual({ suggestions: [] });
  });

  it('rejects missing fields', () => {
    const { sourceContextId: _drop, ...partial } = good.suggestions[0]!;
    expect(SuggestionListSchema.safeParse({ suggestions: [partial] }).success).toBe(false);
  });

  it('rejects out-of-range confidence and wrong types', () => {
    const bad = { ...good.suggestions[0]!, confidence: 1.4 };
    expect(SuggestionListSchema.safeParse({ suggestions: [bad] }).success).toBe(false);
    const str = { ...good.suggestions[0]!, confidence: '0.9' };
    expect(SuggestionListSchema.safeParse({ suggestions: [str] }).success).toBe(false);
  });

  it('rejects extra keys and non-object roots', () => {
    const extra = { ...good.suggestions[0]!, extra: true };
    expect(SuggestionListSchema.safeParse({ suggestions: [extra] }).success).toBe(false);
    expect(SuggestionListSchema.safeParse(good.suggestions).success).toBe(false);
    expect(SuggestionListSchema.safeParse({ suggestions: [], other: 1 }).success).toBe(false);
  });
});

describe('SUGGESTION_JSON_SCHEMA', () => {
  it('is flat and strict-mode compatible', () => {
    const text = JSON.stringify(SUGGESTION_JSON_SCHEMA);
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('enum');
    expect(SUGGESTION_JSON_SCHEMA.additionalProperties).toBe(false);
    const item = SUGGESTION_JSON_SCHEMA.properties.suggestions.items;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
    expect([...SUGGESTION_JSON_SCHEMA.required]).toEqual(Object.keys(SUGGESTION_JSON_SCHEMA.properties));
  });
});
