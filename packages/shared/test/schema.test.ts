import { describe, expect, it } from 'vitest';
import { SUGGESTION_JSON_SCHEMA, SuggestionListSchema } from '../src/schema';

const fill = {
  kind: 'fill',
  fieldId: 'f0',
  value: 'Seven Shores Cafe',
  confidence: 0.92,
  reason: 'place name from Discord',
  sourceContextId: 'c1',
  intent: '',
  when: '',
  location: '',
};

const action = {
  kind: 'action',
  fieldId: '',
  value: 'Dinner at Seven Shores Cafe',
  confidence: 0.8,
  reason: 'invitation with a time',
  sourceContextId: 'o1',
  intent: 'calendar',
  when: '2026-09-18T18:00:00-04:00',
  location: 'Seven Shores Cafe',
};

describe('SuggestionListSchema', () => {
  it('turns the flat wire shape into a fill or an action', () => {
    expect(SuggestionListSchema.parse({ suggestions: [fill, action] })).toEqual({
      suggestions: [
        { kind: 'fill', fieldId: 'f0', value: 'Seven Shores Cafe', confidence: 0.92, reason: 'place name from Discord', sourceContextId: 'c1' },
        {
          kind: 'action',
          intent: 'calendar',
          value: 'Dinner at Seven Shores Cafe',
          when: '2026-09-18T18:00:00-04:00',
          location: 'Seven Shores Cafe',
          confidence: 0.8,
          reason: 'invitation with a time',
          sourceContextId: 'o1',
        },
      ],
    });
    expect(SuggestionListSchema.parse({ suggestions: [] })).toEqual({ suggestions: [] });
  });

  it('reads the pre-kind shape as a fill', () => {
    const { kind: _k, intent: _i, when: _w, location: _l, ...legacy } = fill;
    expect(SuggestionListSchema.parse({ suggestions: [legacy] })).toEqual({ suggestions: [{ kind: 'fill', ...legacy }] });
  });

  it('rejects missing fields, a fill without a fieldId and an action with an unknown intent', () => {
    const { sourceContextId: _drop, ...partial } = fill;
    expect(SuggestionListSchema.safeParse({ suggestions: [partial] }).success).toBe(false);
    expect(SuggestionListSchema.safeParse({ suggestions: [{ ...fill, fieldId: '' }] }).success).toBe(false);
    const res = SuggestionListSchema.safeParse({ suggestions: [{ ...action, intent: 'uber' }] });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0]?.path).toEqual(['suggestions', 0, 'intent']);
  });

  it('rejects out-of-range confidence and wrong types', () => {
    const bad = { ...fill, confidence: 1.4 };
    expect(SuggestionListSchema.safeParse({ suggestions: [bad] }).success).toBe(false);
    const str = { ...fill, confidence: '0.9' };
    expect(SuggestionListSchema.safeParse({ suggestions: [str] }).success).toBe(false);
  });

  it('rejects extra keys and non-object roots', () => {
    const extra = { ...fill, extra: true };
    expect(SuggestionListSchema.safeParse({ suggestions: [extra] }).success).toBe(false);
    expect(SuggestionListSchema.safeParse([fill]).success).toBe(false);
    expect(SuggestionListSchema.safeParse({ suggestions: [], other: 1 }).success).toBe(false);
  });
});

describe('SUGGESTION_JSON_SCHEMA', () => {
  it('is flat and strict-mode compatible', () => {
    const text = JSON.stringify(SUGGESTION_JSON_SCHEMA);
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('enum');
    expect(text).not.toContain('anyOf');
    expect(SUGGESTION_JSON_SCHEMA.additionalProperties).toBe(false);
    const item = SUGGESTION_JSON_SCHEMA.properties.suggestions.items;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
    expect([...SUGGESTION_JSON_SCHEMA.required]).toEqual(Object.keys(SUGGESTION_JSON_SCHEMA.properties));
  });

  it('lists exactly the keys the wire shape carries', () => {
    const item = SUGGESTION_JSON_SCHEMA.properties.suggestions.items;
    expect(Object.keys(item.properties).sort()).toEqual(Object.keys(action).sort());
  });
});
