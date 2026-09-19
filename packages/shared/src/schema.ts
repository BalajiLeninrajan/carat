import { z } from 'zod';
import type { Suggestion } from './types';
import { isIntentName } from './types';

// One flat object carries both kinds: OpenAI strict mode rejects unions and
// optional properties, so a field that does not apply travels as ''. Models
// in json_object or prompt mode sometimes drop the empty ones, hence defaults.
const WireSuggestionSchema = z.strictObject({
  kind: z.enum(['fill', 'action']).default('fill'),
  fieldId: z.string().default(''),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  sourceContextId: z.string().min(1),
  intent: z.string().default(''),
  when: z.string().default(''),
  location: z.string().default(''),
});

export const SuggestionSchema = WireSuggestionSchema.transform((w, ctx): Suggestion => {
  const base = { value: w.value, confidence: w.confidence, reason: w.reason, sourceContextId: w.sourceContextId };
  if (w.kind === 'fill') {
    if (w.fieldId === '') ctx.addIssue({ code: 'custom', path: ['fieldId'], message: 'a fill needs a fieldId' });
    return { kind: 'fill', fieldId: w.fieldId, ...base };
  }
  if (!isIntentName(w.intent)) {
    ctx.addIssue({ code: 'custom', path: ['intent'], message: `unknown intent "${w.intent}"` });
    return { kind: 'action', intent: 'maps', when: '', location: '', ...base };
  }
  return { kind: 'action', intent: w.intent, when: w.when, location: w.location, ...base };
});

// OpenAI strict json_schema needs an object root, so the list is wrapped.
export const SuggestionListSchema = z.strictObject({
  suggestions: z.array(SuggestionSchema),
});

export type SuggestionList = z.output<typeof SuggestionListSchema>;

// Hand-written rather than derived: strict mode rejects $ref, enums and
// optional properties, and the wire shape must never drift by accident.
export const SUGGESTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          fieldId: { type: 'string' },
          value: { type: 'string' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          sourceContextId: { type: 'string' },
          intent: { type: 'string' },
          when: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['kind', 'fieldId', 'value', 'confidence', 'reason', 'sourceContextId', 'intent', 'when', 'location'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
} as const;

export const SUGGESTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'carat', strict: true, schema: SUGGESTION_JSON_SCHEMA },
} as const;
