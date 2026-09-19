import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SuggestRequest, Suggestion } from '@carat/shared';
import { z } from 'zod';

export interface Expectation {
  fieldId: string;
  valueIncludes: string;
}

export interface Fixture {
  name: string;
  request: SuggestRequest;
  expect: Expectation[];
}

const FixtureSchema = z.object({
  name: z.string().min(1),
  request: z.custom<SuggestRequest>((v) => typeof v === 'object' && v !== null && Array.isArray((v as SuggestRequest).fields)),
  expect: z.array(z.object({ fieldId: z.string().min(1), valueIncludes: z.string().min(1) })),
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

/** A negative fixture passes only on []. A positive one passes when every expectation is met; extra suggestions are allowed. */
export function judge(fixture: Fixture, got: Suggestion[]): Verdict {
  const summary = got.length === 0 ? '[]' : got.map((s) => `${s.fieldId}=${JSON.stringify(s.value)}`).join(' ');
  if (fixture.expect.length === 0) {
    return got.length === 0 ? { pass: true, detail: '[]' } : { pass: false, detail: `expected [] got ${summary}` };
  }
  const missing = fixture.expect.filter(
    (e) => !got.some((s) => s.fieldId === e.fieldId && s.value.includes(e.valueIncludes)),
  );
  if (missing.length === 0) return { pass: true, detail: summary };
  const want = missing.map((e) => `${e.fieldId}~${JSON.stringify(e.valueIncludes)}`).join(' ');
  return { pass: false, detail: `wanted ${want} got ${summary}` };
}
