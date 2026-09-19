import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, judge, loadFixtures, type Fixture } from '../eval/fixtures';

const cleanup: string[] = [];
afterAll(() => Promise.all(cleanup.map((d) => rm(d, { recursive: true, force: true }))));

describe('loadFixtures', () => {
  it('loads every fixture in name order', async () => {
    const names = (await loadFixtures()).map((f) => f.name);
    expect(names.length).toBe(9);
    expect(names).toEqual([...names].sort());
  });

  it('reads from a directory whose path has a space and a hash', async () => {
    const base = await mkdtemp(join(tmpdir(), 'carat-'));
    cleanup.push(base);
    const dir = join(base, 'fix tures #1');
    await cp(FIXTURES_DIR, dir, { recursive: true });
    expect((await loadFixtures(dir)).length).toBe(9);
  });
});

describe('judge', () => {
  const positive: Fixture = { name: 'p', request: { page: { host: 'x', title: '', path: '/' }, fields: [], context: [], now: '' }, expect: [{ fieldId: 'f0', valueIncludes: 'Seven Shores' }] };
  const negative: Fixture = { ...positive, name: 'n', expect: [] };
  const hit = { fieldId: 'f0', value: 'Seven Shores Cafe', confidence: 0.75, reason: '', sourceContextId: 'c1' };

  it('fails a positive on [] or the wrong field, passes on a substring match', () => {
    expect(judge(positive, []).pass).toBe(false);
    expect(judge(positive, [{ ...hit, fieldId: 'f1' }]).pass).toBe(false);
    expect(judge(positive, [hit]).pass).toBe(true);
  });

  it('fails a negative on any suggestion', () => {
    expect(judge(negative, [])).toEqual({ pass: true, detail: '[]' });
    expect(judge(negative, [hit]).pass).toBe(false);
  });
});
