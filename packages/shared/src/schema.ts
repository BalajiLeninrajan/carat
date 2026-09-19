import { z } from 'zod';
import type { NextAction, NextActionKind } from './next-action';

const KINDS: readonly NextActionKind[] = ['fill', 'click', 'select', 'scroll', 'open', 'switch', 'none'];

// Hand-written rather than derived: OpenAI's strict mode rejects $ref and
// optional properties, and the wire shape must never drift by accident.
// `target` is the first property so the streamed JSON carries it first and the
// chip can ring the control before the label has arrived.
export const NEXT_ACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: ['integer', 'null'] },
    kind: { type: 'string', enum: [...KINDS] },
    value: { type: 'string' },
    label: { type: 'string' },
    irreversible: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['target', 'kind', 'value', 'label', 'irreversible', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

export const NEXT_ACTION_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'next_action', strict: true, schema: NEXT_ACTION_JSON_SCHEMA },
} as const;

/**
 * A model in json_object or prompt mode drops keys it thinks are empty, so
 * everything but the kind and the target has a default. Nothing here is a
 * safety check: the orchestrator validates the action against the page.
 */
export const NextActionSchema = z
  .object({
    kind: z.enum(KINDS as [NextActionKind, ...NextActionKind[]]),
    target: z.number().int().nullable().default(null),
    value: z.string().default(''),
    label: z.string().default(''),
    irreversible: z.boolean().default(false),
    confidence: z.number().min(0).max(1).default(0.5),
    reason: z.string().default(''),
  })
  .transform((a): NextAction => ({ ...a, value: a.value.trim(), label: a.label.trim() }));

export type ParsedAction = { ok: true; action: NextAction } | { ok: false; error: string };

export function parseNextAction(text: unknown): ParsedAction {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'the reply had no text content' };
  let data: unknown;
  try {
    data = JSON.parse(stripFences(text));
  } catch {
    const salvaged = salvageNextAction(text);
    return salvaged ? { ok: true, action: salvaged } : { ok: false, error: 'invalid JSON' };
  }
  const result = NextActionSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`);
    return { ok: false, error: `schema mismatch (${issues.join('; ')})` };
  }
  return { ok: true, action: result.data };
}

export function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1]! : t;
}

/** `"target": <int>` out of partial JSON, as soon as the number is complete. */
export function partialTarget(json: string): number | null {
  const m = /"target"\s*:\s*(-?\d+)\s*[,}]/.exec(json);
  return m ? Number(m[1]) : null;
}

/**
 * Recover an action from JSON that was cut off, which happens when the output
 * limit lands in the middle of a long fill value. `target` and `kind` come
 * first in the schema, so they are almost always complete; a truncated value
 * is trimmed back to its last full sentence, else its last whole word, so it
 * never ends mid-word.
 */
export function salvageNextAction(json: string): NextAction | null {
  const target = /"target"\s*:\s*(-?\d+|null)/.exec(json);
  const kind = /"kind"\s*:\s*"(fill|click|select|scroll|open|switch|none)"/.exec(json);
  if (!kind) return null;

  let value = '';
  const v = /"value"\s*:\s*"((?:[^"\\]|\\.)*)("?)/.exec(json);
  if (v) {
    const raw = v[1]!.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, ''); // drop a half-written escape
    try {
      value = JSON.parse(`"${raw}"`) as string;
    } catch {
      value = '';
    }
    if (!v[2]) {
      const sentence = /^[\s\S]*[.!?](?=\s|$)/.exec(value)?.[0];
      value = sentence ?? value.replace(/\s+\S*$/, '');
    }
  }
  const label = quoted(/"label"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json)?.[1]);
  const reason = quoted(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json)?.[1]);
  const confidence = Number(/"confidence"\s*:\s*([0-9.]+)/.exec(json)?.[1] ?? NaN);
  const n = target?.[1];
  return {
    kind: kind[1] as NextActionKind,
    target: n === undefined || n === 'null' ? null : Number(n),
    value: value.trim(),
    label,
    irreversible: /"irreversible"\s*:\s*true/.test(json),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    reason,
  };
}

function quoted(raw: string | undefined): string {
  if (raw === undefined) return '';
  try {
    return (JSON.parse(`"${raw}"`) as string).trim();
  } catch {
    return raw.trim();
  }
}

/**
 * Labels that mean "this cannot be undone", whatever the model said. The
 * model's own `irreversible` flag is the first word; this is the backstop,
 * and the outline's `risky` flag on a control is the other one.
 */
export const IRREVERSIBLE_LABEL =
  /\b(send|submit|pay|paying|purchase|buy|order|place|checkout|check ?out|delete|remove|discard|publish|post|confirm|transfer|sign ?out|log ?out|unsubscribe|cancel)\b/i;

/** Names that move money; acting on one needs the payments setting. */
export const MONEY_LABEL = /\b(pay|payment|buy|purchase|order|checkout|check ?out|book|subscribe|donate|tip|charge)\b/i;

export function isIrreversibleLabel(text: string): boolean {
  return IRREVERSIBLE_LABEL.test(text);
}

export function isMoneyLabel(text: string): boolean {
  return MONEY_LABEL.test(text);
}
