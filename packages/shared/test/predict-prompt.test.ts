import { describe, expect, it } from 'vitest';
import {
  ENTITY_JSON_SCHEMA,
  ENTITY_KINDS,
  ENTITY_RESPONSE_FORMAT,
  EntityListSchema,
  MAX_FIELD_HINTS,
  PREDICT_FEW_SHOTS,
  PREDICT_PROMPT,
  buildPredictMessages,
} from '../src';
import type { PredictInput } from '../src';

const input: PredictInput = {
  origin: 'https://discord.com',
  title: 'Discord | #general',
  kind: 'page',
  text: 'alex: dinner at Seven Shores Cafe, Friday at 6?',
  now: '2026-09-16T14:04:00-04:00',
};

describe('buildPredictMessages', () => {
  it('keeps every turn but the last byte-identical across calls, so the prompt cache hits', () => {
    const a = buildPredictMessages(input);
    const b = buildPredictMessages({ ...input, text: 'something else entirely', now: '2026-09-17T09:00:00-04:00' });
    expect(a.length).toBe(b.length);
    expect(a.slice(0, -1)).toEqual(b.slice(0, -1));
    expect(a[0]).toEqual({ role: 'system', content: PREDICT_PROMPT });
    expect(a.slice(1, -1)).toEqual(PREDICT_FEW_SHOTS);
    expect(a.at(-1)!.content).not.toBe(b.at(-1)!.content);
  });

  it('sends only what the model needs to read: no tab id, no store id, no hash', () => {
    const last = JSON.parse(buildPredictMessages({ ...input, id: 'p123', tabId: 4, hash: 9 } as PredictInput).at(-1)!.content);
    expect(Object.keys(last).sort()).toEqual(['kind', 'now', 'origin', 'text', 'title']);
  });

  it('names every kind in the prompt and parses every few-shot answer', () => {
    for (const kind of ENTITY_KINDS) expect(PREDICT_PROMPT).toContain(`\`${kind}\``);
    for (const turn of PREDICT_FEW_SHOTS.filter((m) => m.role === 'assistant')) {
      expect(EntityListSchema.safeParse(JSON.parse(turn.content)).success).toBe(true);
    }
  });
});

describe('EntityListSchema', () => {
  it('normalises hints and falls back to kind "other" for a name it does not know', () => {
    const parsed = EntityListSchema.parse({
      entities: [{ value: ' Seven Shores Cafe ', kind: 'venue', fieldHints: ['Search', 'search', ' Location ', '', 'a', 'b', 'c', 'd', 'e'], confidence: 0.9 }],
    });
    expect(parsed.entities[0]).toEqual({
      value: 'Seven Shores Cafe',
      kind: 'other',
      fieldHints: ['search', 'location', 'a', 'b', 'c', 'd'].slice(0, MAX_FIELD_HINTS),
      confidence: 0.9,
    });
  });

  it('rejects an empty value, an out-of-range confidence and an unknown key', () => {
    expect(EntityListSchema.safeParse({ entities: [{ value: '', kind: 'place', fieldHints: [], confidence: 0.5 }] }).success).toBe(false);
    expect(EntityListSchema.safeParse({ entities: [{ value: 'x', kind: 'place', fieldHints: [], confidence: 1.5 }] }).success).toBe(false);
    expect(EntityListSchema.safeParse({ entities: [{ value: 'x', kind: 'place', fieldHints: [], confidence: 0.5, extra: 1 }] }).success).toBe(false);
  });

  it('matches the strict wire schema key for key', () => {
    const item = ENTITY_JSON_SCHEMA.properties.entities.items;
    expect(item.required).toEqual(Object.keys(item.properties));
    expect(item.additionalProperties).toBe(false);
    expect(ENTITY_RESPONSE_FORMAT.json_schema.strict).toBe(true);
    const parsed = EntityListSchema.parse({ entities: [{ value: 'x', kind: 'code', fieldHints: ['code'], confidence: 0.8 }] });
    expect(Object.keys(parsed.entities[0]!).sort()).toEqual([...item.required].sort());
  });
});
