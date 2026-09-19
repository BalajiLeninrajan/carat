import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, judge, loadFixtures, type Fixture } from '../eval/fixtures';

const FIXTURE_COUNT = 25;
const cleanup: string[] = [];
afterAll(() => Promise.all(cleanup.map((d) => rm(d, { recursive: true, force: true }))));

describe('loadFixtures', () => {
  it('loads every fixture in name order', async () => {
    const names = (await loadFixtures()).map((f) => f.name);
    expect(names.length).toBe(FIXTURE_COUNT);
    expect(names).toEqual([...names].sort());
  });

  it('reads from a directory whose path has a space and a hash', async () => {
    const base = await mkdtemp(join(tmpdir(), 'carat-'));
    cleanup.push(base);
    const dir = join(base, 'fix tures #1');
    await cp(FIXTURES_DIR, dir, { recursive: true });
    expect((await loadFixtures(dir)).length).toBe(FIXTURE_COUNT);
  });
});

describe('judge', () => {
  const request = { page: { host: 'x', title: '', path: '/' }, fields: [], context: [], now: '' };
  const positive: Fixture = { name: 'p', request, expect: [{ fieldId: 'f0', valueIncludes: 'Seven Shores' }] };
  const negative: Fixture = { ...positive, name: 'n', expect: [] };
  const hit = { kind: 'fill' as const, fieldId: 'f0', value: 'Seven Shores Cafe', confidence: 0.75, reason: '', sourceContextId: 'c1' };
  const nav = { kind: 'action' as const, intent: 'maps' as const, value: 'Seven Shores Cafe', when: '', location: '', confidence: 0.75, reason: '', sourceContextId: 'o1' };
  const click = { kind: 'interact' as const, elementId: 'e0', verb: 'click' as const, value: 'Save', confidence: 0.75, reason: '', sourceContextId: 'c1' };

  it('fails a positive on [] or the wrong field, passes on a substring match', () => {
    expect(judge(positive, []).pass).toBe(false);
    expect(judge(positive, [{ ...hit, fieldId: 'f1' }]).pass).toBe(false);
    expect(judge(positive, [hit]).pass).toBe(true);
  });

  it('fails a negative on any suggestion, fill or action', () => {
    expect(judge(negative, [])).toEqual({ pass: true, detail: '[]' });
    expect(judge(negative, [hit]).pass).toBe(false);
    expect(judge(negative, [nav]).pass).toBe(false);
  });

  it('matches an interaction on element, verb and value, and fails a negative on one', () => {
    const wantClick: Fixture = { ...positive, expect: [{ elementId: 'e0', verb: 'click', valueIncludes: 'Save' }] };
    expect(judge(wantClick, [click])).toEqual({ pass: true, detail: 'e0.click("Save")' });
    expect(judge(wantClick, [{ ...click, verb: 'check' }]).pass).toBe(false);
    expect(judge(wantClick, [{ ...click, elementId: 'e1' }]).detail).toContain('wanted e0.click~"Save"');
    expect(judge(wantClick, [hit]).pass).toBe(false);
    expect(judge(negative, [click]).pass).toBe(false);
  });

  it('swaps in a level\'s own expectations, and tolerates a weak chip on a negative only where the fixture says so', () => {
    const eagerOnly: Fixture = { ...negative, expectAt: { eager: [{ fieldId: 'f0', valueIncludes: 'Seven Shores' }] } };
    expect(judge(eagerOnly, [hit], 'eager').pass).toBe(true);
    expect(judge(eagerOnly, [], 'eager').pass).toBe(false);
    expect(judge(eagerOnly, [], 'balanced').pass).toBe(true);
    expect(judge(eagerOnly, [hit], 'balanced').pass).toBe(false);

    const tolerant: Fixture = { ...negative, weakOkAt: ['eager'] };
    const weak = { ...hit, confidence: 0.45 };
    expect(judge(tolerant, [weak], 'eager')).toMatchObject({ pass: true, weak: true });
    expect(judge(tolerant, [weak], 'eager').detail).toContain('weak chip tolerated at eager');
    // 0.75 would have shown at balanced too, so it is a real false positive, not a weak one.
    expect(judge(tolerant, [hit], 'eager').pass).toBe(false);
    expect(judge(tolerant, [weak, hit], 'eager').pass).toBe(false);
    expect(judge(tolerant, [weak], 'balanced').pass).toBe(false);
    expect(judge(negative, [weak], 'eager').pass).toBe(false);
    // The default level is the product default.
    expect(judge(tolerant, [weak]).pass).toBe(true);
  });

  it('matches a page scroll on an empty elementId with no value, and prints it as page.scroll', () => {
    const wantScroll: Fixture = { ...positive, expect: [{ elementId: '', verb: 'scroll', valueIncludes: '' }] };
    const scroll = { ...click, elementId: '', verb: 'scroll' as const, value: '', sourceContextId: 'page' };
    expect(judge(wantScroll, [scroll])).toEqual({ pass: true, detail: 'page.scroll("")' });
    expect(judge(wantScroll, [click]).detail).toContain('wanted page.scroll~""');
    expect(judge(negative, [scroll]).pass).toBe(false);
  });

  it('matches an action on intent, value and the start of when', () => {
    const wantMaps: Fixture = { ...positive, expect: [{ intent: 'maps', valueIncludes: 'Seven Shores' }] };
    expect(judge(wantMaps, [nav]).pass).toBe(true);
    expect(judge(wantMaps, [hit]).pass).toBe(false);
    expect(judge(wantMaps, [{ ...nav, intent: 'calendar' }]).pass).toBe(false);

    const wantWhen: Fixture = { ...positive, expect: [{ intent: 'calendar', valueIncludes: 'Dinner', whenStartsWith: '2026-09-18T18' }] };
    const cal = { ...nav, intent: 'calendar' as const, value: 'Dinner at Seven Shores Cafe', when: '2026-09-18T18:00:00-04:00' };
    expect(judge(wantWhen, [cal])).toEqual({ pass: true, detail: 'calendar="Dinner at Seven Shores Cafe"@2026-09-18T18:00:00-04:00' });
    expect(judge(wantWhen, [{ ...cal, when: '2026-09-19T18:00:00-04:00' }]).detail).toContain('wanted calendar~"Dinner"@2026-09-18T18');
  });
});
