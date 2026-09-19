import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SuggestRequest, Suggestion } from '@carat/shared';
import { z } from 'zod';

/**
 * A fill is expected by `fieldId`, an action by `intent`, an interaction by
 * `elementId` plus `verb`; `whenStartsWith` pins an action's start time.
 */
export interface Expectation {
  fieldId?: string;
  intent?: string;
  elementId?: string;
  verb?: string;
  valueIncludes: string;
  whenStartsWith?: string;
}

export interface Fixture {
  name: string;
  request: SuggestRequest;
  expect: Expectation[];
}

const ExpectationSchema = z
  .object({
    fieldId: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
    elementId: z.string().min(1).optional(),
    verb: z.string().min(1).optional(),
    valueIncludes: z.string().min(1),
    whenStartsWith: z.string().min(1).optional(),
  })
  .refine(
    (e) => [e.fieldId, e.intent, e.elementId].filter((v) => v !== undefined).length === 1,
    'an expectation names exactly one of fieldId, intent or elementId',
  )
  .refine((e) => (e.verb === undefined) === (e.elementId === undefined), 'verb goes with elementId');

const FixtureSchema = z.object({
  name: z.string().min(1),
  request: z.custom<SuggestRequest>((v) => typeof v === 'object' && v !== null && Array.isArray((v as SuggestRequest).fields)),
  expect: z.array(ExpectationSchema),
});

export const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

export async function loadFixtures(dir: string = FIXTURES_DIR): Promise<Fixture[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (n) => {
      const raw: unknown = JSON.parse(await readFile(join(dir, n), 'utf8'));
      const parsed = FixtureSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`fixture ${n}: ${z.prettifyError(parsed.error)}`);
      return parsed.data;
    }),
  );
}

export interface Verdict {
  pass: boolean;
  detail: string;
}

function describe(s: Suggestion): string {
  if (s.kind === 'fill') return `${s.fieldId}=${JSON.stringify(s.value)}`;
  if (s.kind === 'interact') return `${s.elementId}.${s.verb}(${JSON.stringify(s.value)})`;
  return `${s.intent}=${JSON.stringify(s.value)}${s.when ? `@${s.when}` : ''}`;
}

function meets(e: Expectation, s: Suggestion): boolean {
  if (!s.value.includes(e.valueIncludes)) return false;
  if (s.kind === 'fill') return e.fieldId === s.fieldId;
  if (s.kind === 'interact') return e.elementId === s.elementId && e.verb === s.verb;
  if (e.intent !== s.intent) return false;
  return e.whenStartsWith === undefined || s.when.startsWith(e.whenStartsWith);
}

/** A negative fixture passes only on []. A positive one passes when every expectation is met; extra suggestions are allowed. */
export function judge(fixture: Fixture, got: Suggestion[]): Verdict {
  const summary = got.length === 0 ? '[]' : got.map(describe).join(' ');
  if (fixture.expect.length === 0) {
    return got.length === 0 ? { pass: true, detail: '[]' } : { pass: false, detail: `expected [] got ${summary}` };
  }
  const missing = fixture.expect.filter((e) => !got.some((s) => meets(e, s)));
  if (missing.length === 0) return { pass: true, detail: summary };
  const want = missing
    .map((e) => `${e.fieldId ?? e.intent ?? `${e.elementId}.${e.verb}`}~${JSON.stringify(e.valueIncludes)}${e.whenStartsWith ? `@${e.whenStartsWith}` : ''}`)
    .join(' ');
  return { pass: false, detail: `wanted ${want} got ${summary}` };
}
