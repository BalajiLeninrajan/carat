import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Eagerness, SuggestRequest, Suggestion } from '@carat/shared';
import { DEFAULT_EAGERNESS, EAGERNESS_LEVELS, weakBelow } from '@carat/shared';
import { z } from 'zod';

/**
 * A fill is expected by `fieldId`, an action by `intent`, an interaction by
 * `elementId` plus `verb` (an empty `elementId` with `verb: "scroll"` is the
 * page scroll); `whenStartsWith` pins an action's start time. `valueIncludes`
 * may be left out for a scroll, which carries no value.
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
  /** Expectations that replace `expect` at one level: a chip only that level is meant to produce. */
  expectAt?: Partial<Record<Eagerness, Expectation[]>>;
  /**
   * Levels at which a negative may still produce a chip, as long as every
   * suggestion sits under the next stricter level's floor. That is the
   * documented cost of the level: one Esc on a weak chip.
   */
  weakOkAt?: Eagerness[];
}

const ExpectationSchema = z
  .object({
    fieldId: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
    elementId: z.string().optional(),
    verb: z.string().min(1).optional(),
    valueIncludes: z.string().default(''),
    whenStartsWith: z.string().min(1).optional(),
  })
  .refine(
    (e) => [e.fieldId, e.intent, e.elementId].filter((v) => v !== undefined).length === 1,
    'an expectation names exactly one of fieldId, intent or elementId',
  )
  .refine((e) => (e.verb === undefined) === (e.elementId === undefined), 'verb goes with elementId')
  .refine((e) => e.valueIncludes !== '' || e.verb === 'scroll', 'valueIncludes may only be empty for a scroll');

const LevelSchema = z.enum(EAGERNESS_LEVELS);

const FixtureSchema = z.object({
  name: z.string().min(1),
  request: z.custom<SuggestRequest>((v) => typeof v === 'object' && v !== null && Array.isArray((v as SuggestRequest).fields)),
  expect: z.array(ExpectationSchema),
  expectAt: z.partialRecord(LevelSchema, z.array(ExpectationSchema)).optional(),
  weakOkAt: z.array(LevelSchema).optional(),
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
  /** A negative that passed only because its chips were weak enough for this level to tolerate. */
  weak?: true;
}

/** What the fixture expects at this level. */
export function expectationsAt(fixture: Fixture, eagerness: Eagerness): Expectation[] {
  return fixture.expectAt?.[eagerness] ?? fixture.expect;
}

function describe(s: Suggestion): string {
  if (s.kind === 'fill') return `${s.fieldId}=${JSON.stringify(s.value)}`;
  if (s.kind === 'interact') return `${s.elementId || 'page'}.${s.verb}(${JSON.stringify(s.value)})`;
  return `${s.intent}=${JSON.stringify(s.value)}${s.when ? `@${s.when}` : ''}`;
}

function meets(e: Expectation, s: Suggestion): boolean {
  if (!s.value.includes(e.valueIncludes)) return false;
  if (s.kind === 'fill') return e.fieldId === s.fieldId;
  if (s.kind === 'interact') return e.elementId === s.elementId && e.verb === s.verb;
  if (e.intent !== s.intent) return false;
  return e.whenStartsWith === undefined || s.when.startsWith(e.whenStartsWith);
}

/**
 * A negative fixture passes only on [], or, at a level it lists in
 * `weakOkAt`, on chips that would all have been dropped one level up. A
 * positive one passes when every expectation is met; extra suggestions are
 * allowed.
 */
export function judge(fixture: Fixture, got: Suggestion[], eagerness: Eagerness = DEFAULT_EAGERNESS): Verdict {
  const summary = got.length === 0 ? '[]' : got.map(describe).join(' ');
  const expectations = expectationsAt(fixture, eagerness);
  if (expectations.length === 0) {
    if (got.length === 0) return { pass: true, detail: '[]' };
    const floor = weakBelow(eagerness);
    if (fixture.weakOkAt?.includes(eagerness) && got.every((s) => s.confidence < floor)) {
      return { pass: true, weak: true, detail: `weak chip tolerated at ${eagerness} (all under ${floor}): ${summary}` };
    }
    return { pass: false, detail: `expected [] got ${summary}` };
  }
  const missing = expectations.filter((e) => !got.some((s) => meets(e, s)));
  if (missing.length === 0) return { pass: true, detail: summary };
  const want = missing
    .map((e) => `${e.fieldId ?? e.intent ?? `${e.elementId || 'page'}.${e.verb}`}~${JSON.stringify(e.valueIncludes)}${e.whenStartsWith ? `@${e.whenStartsWith}` : ''}`)
    .join(' ');
  return { pass: false, detail: `wanted ${want} got ${summary}` };
}
