import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { sideEffects?: unknown };

describe('package.json', () => {
  // The index re-exports schema.ts, whose top-level zod calls bundlers cannot
  // prove pure. Without this flag every consumer of any shared export (the
  // content script included) ships zod and the prompt text.
  it('declares the package side-effect free so consumers can tree-shake zod', () => {
    expect(pkg.sideEffects).toBe(false);
  });
});
