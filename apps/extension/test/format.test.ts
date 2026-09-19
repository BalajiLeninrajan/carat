import { describe, expect, it } from 'vitest';
import { relativeAge } from '../src/format/age';
import { describeCapture, describeSuggest } from '../src/format/diag';

const NOW = 1_000_000;

describe('relativeAge', () => {
  it('rounds to the coarsest unit that reads naturally', () => {
    expect(relativeAge(NOW - 3_000, NOW)).toBe('just now');
    expect(relativeAge(NOW - 42_000, NOW)).toBe('42s ago');
    expect(relativeAge(NOW - 2 * 60_000, NOW)).toBe('2m ago');
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(relativeAge(NOW + 5_000, NOW)).toBe('just now');
  });
});

describe('describeCapture', () => {
  it('says what happened to the last capture', () => {
    expect(describeCapture({ at: NOW - 12_000, host: 'discord.com', kind: 'page', verdict: 'stored' }, NOW)).toBe(
      'page from discord.com 12s ago: stored',
    );
    expect(describeCapture({ at: NOW, host: 'discord.com', kind: 'selection', verdict: 'pinned' }, NOW)).toBe(
      'selection from discord.com just now: skipped, context is pinned',
    );
  });
});

describe('describeSuggest', () => {
  const base = { at: NOW - 15_000, host: 'www.google.com', fields: 1 };

  it('explains a stopped request', () => {
    expect(describeSuggest({ ...base, gate: 'own-context' }, NOW)).toBe(
      'checked 15s ago: no request, the only context is from another tab on this site',
    );
    expect(describeSuggest({ ...base, gate: 'stale-context' }, NOW)).toBe(
      'checked 15s ago: no request, all context is older than 30 min',
    );
  });

  it('lists every provider attempt with latency, count and error', () => {
    expect(
      describeSuggest(
        {
          ...base,
          gate: 'ok',
          cached: false,
          attempts: [
            { id: 'openai', ms: 812, count: 0, error: 'HTTP 401' },
            { id: 'local', ms: 3, count: 1 },
          ],
          offered: 1,
        },
        NOW,
      ),
    ).toBe('checked 15s ago: openai failed after 812 ms (HTTP 401); local answered in 3 ms with 1, offered 1');
  });

  it('counts tab offers separately from fills', () => {
    expect(describeSuggest({ ...base, gate: 'ok', cached: false, attempts: [{ id: 'local', ms: 2, count: 2 }], offered: 0, navigation: 1 }, NOW)).toBe(
      'checked 15s ago: local answered in 2 ms with 2, offered 0, 1 tab offer',
    );
    expect(describeSuggest({ ...base, gate: 'ok', cached: true, offered: 1, navigation: 2 }, NOW)).toBe(
      'checked 15s ago: answer from cache, offered 1, 2 tab offers',
    );
  });

  it('counts controls after tab offers', () => {
    expect(describeSuggest({ ...base, gate: 'ok', cached: true, offered: 1, interactions: 1 }, NOW)).toBe(
      'checked 15s ago: answer from cache, offered 1, 1 control',
    );
    expect(describeSuggest({ ...base, gate: 'ok', cached: true, offered: 0, navigation: 1, interactions: 2 }, NOW)).toBe(
      'checked 15s ago: answer from cache, offered 0, 1 tab offer, 2 controls',
    );
  });

  it('says when the answer came from cache', () => {
    expect(describeSuggest({ ...base, gate: 'ok', cached: true, offered: 0 }, NOW)).toBe(
      'checked 15s ago: answer from cache, offered 0',
    );
  });
});
