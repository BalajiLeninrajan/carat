import { z } from 'zod';

export const SuggestionSchema = z.strictObject({
  fieldId: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  sourceContextId: z.string().min(1),
});

// OpenAI strict json_schema needs an object root, so the list is wrapped.
export const SuggestionListSchema = z.strictObject({
  suggestions: z.array(SuggestionSchema),
});

export type SuggestionList = z.infer<typeof SuggestionListSchema>;

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
          fieldId: { type: 'string' },
          value: { type: 'string' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          sourceContextId: { type: 'string' },
        },
        required: ['fieldId', 'value', 'confidence', 'reason', 'sourceContextId'],
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
