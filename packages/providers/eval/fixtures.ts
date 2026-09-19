import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextAction, NextActionKind, NextActionRequest } from '@carat/shared';
import { z } from 'zod';

/**
 * One fixture is one page, and one action it should answer with. `expect` is
 * what a model should do; `expectLocal` is what the regex placeholder should
 * do with no network at all, which is usually `none`. A negative expects
 * `none`, or names the targets and kinds that would be wrong.
 */
export interface Expectation {
  /** The kind the action must have; `any` when only the forbidden list matters. */
  kind: NextActionKind | 'any';
  target?: number;
  valueIncludes?: string;
  irreversible?: boolean;
  /** Controls the action must not name: the pay button, the delete link. */
  forbidTargets?: number[];
  forbidKinds?: NextActionKind[];
}

export interface Fixture {
  name: string;
  request: NextActionRequest;
  expect: Expectation;
  /** What the offline placeholder must answer; `{ kind: 'none' }` when it is left out. */
  expectLocal?: Expectation;
}

const KINDS = ['fill', 'click', 'select', 'scroll', 'open', 'switch', 'none'] as const;

const ExpectationSchema = z.object({
  kind: z.enum([...KINDS, 'any']),
  target: z.number().int().optional(),
  valueIncludes: z.string().optional(),
  irreversible: z.boolean().optional(),
  forbidTargets: z.array(z.number().int()).optional(),
  forbidKinds: z.array(z.enum(KINDS)).optional(),
});

const FixtureSchema = z.object({
  name: z.string().min(1),
  request: z.custom<NextActionRequest>(
    (v) => typeof v === 'object' && v !== null && Array.isArray((v as NextActionRequest).controls),
    'a fixture request needs a controls array',
  ),
  expect: ExpectationSchema,
  expectLocal: ExpectationSchema.optional(),
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

export const NONE_EXPECTED: Expectation = { kind: 'none' };

export function describeAction(a: NextAction | null): string {
  if (!a) return 'nothing';
  const target = a.target === null ? '' : ` [${a.target}]`;
  const value = a.value ? ` ${JSON.stringify(a.value)}` : '';
  return `${a.kind}${target}${value} (${a.confidence})`;
}

function describeExpectation(e: Expectation): string {
  const bits: string[] = [e.kind];
  if (e.target !== undefined) bits.push(`[${e.target}]`);
  if (e.valueIncludes) bits.push(JSON.stringify(e.valueIncludes));
  if (e.forbidTargets?.length) bits.push(`not [${e.forbidTargets.join(',')}]`);
  if (e.forbidKinds?.length) bits.push(`not ${e.forbidKinds.join('/')}`);
  return bits.join(' ');
}

/** No answer at all counts as `none`: both mean no chip. */
export function judge(action: NextAction | null, expectation: Expectation): Verdict {
  const got = action ?? { kind: 'none' as const, target: null, value: '', label: '', irreversible: false, confidence: 0, reason: '' };
  const fail = (why: string): Verdict => ({ pass: false, detail: `${why}: wanted ${describeExpectation(expectation)}, got ${describeAction(action)}` });
  if (expectation.kind !== 'any' && got.kind !== expectation.kind) return fail('wrong kind');
  if (expectation.target !== undefined && got.target !== expectation.target) return fail('wrong target');
  if (expectation.valueIncludes && !got.value.includes(expectation.valueIncludes)) return fail('wrong value');
  if (expectation.irreversible !== undefined && got.irreversible !== expectation.irreversible) return fail('wrong irreversible flag');
  if (got.kind !== 'none') {
    if (expectation.forbidKinds?.includes(got.kind)) return fail('forbidden kind');
    if (got.target !== null && expectation.forbidTargets?.includes(got.target)) return fail('forbidden target');
  }
  return { pass: true, detail: describeAction(action) };
}
