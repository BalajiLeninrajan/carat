import { describe, expect, it } from 'vitest';
import { relativeAge } from '../src/format/age';
import { describeCapture, describePerform, describePrewarm, describeSuggest, describeVision } from '../src/format/diag';

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
    expect(describeSuggest({ ...base, gate: 'no-snapshot' }, NOW)).toBe('checked 15s ago: no request, nothing on the page to act on');
    expect(describeSuggest({ ...base, gate: 'site-off' }, NOW)).toBe('checked 15s ago: no request, carat is off for this site');
  });

  it('names the page kind and the prior the local predictor found', () => {
    expect(describeSuggest({ ...base, gate: 'ok', pageKind: 'serp', prior: "first result matches query 'doordash'", offered: 0, interactions: 1 }, NOW)).toBe(
      "checked 15s ago on a serp (first result matches query 'doordash'): no provider ran, offered 0, 1 control",
    );
    expect(describeSuggest({ ...base, gate: 'ok', pageKind: 'article', prior: 'scroll', cached: true }, NOW)).toBe(
      'checked 15s ago on an article (scroll): answer from cache, offered 0',
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

  it('says how many links matched the page query, and when that answered without a provider', () => {
    expect(describeSuggest({ ...base, gate: 'ok', cached: false, attempts: [], offered: 0, interactions: 1, query: 'doordash', linkMatched: 1 }, NOW)).toBe(
      "checked 15s ago: answered from the page query, no provider asked, offered 0, 1 control, 1 link matched the page query 'doordash'",
    );
    expect(describeSuggest({ ...base, gate: 'ok', cached: false, attempts: [{ id: 'local', ms: 2, count: 0 }], offered: 0, query: 'weather', linkMatched: 0 }, NOW)).toBe(
      "checked 15s ago: local answered in 2 ms with 0, offered 0, 0 links matched the page query 'weather'",
    );
  });
});

describe('describePerform', () => {
  it('names the money control that was pressed, and the fill that stopped short', () => {
    expect(describePerform({ at: NOW - 12_000, host: 'aircanada.com', kind: 'money', name: 'Pay $312.40', outcome: 'done' }, NOW)).toBe(
      'pressed "Pay $312.40" on aircanada.com 12s ago (Enter)',
    );
    expect(describePerform({ at: NOW, host: 'aircanada.com', kind: 'fill', name: 'f2', outcome: 'partial' }, NOW)).toBe(
      'filled f2 on aircanada.com just now, pick left undone',
    );
  });
});

describe('describeVision', () => {
  it('says what became of the last screenshot cue', () => {
    expect(describeVision({ at: NOW - 30_000, host: 'discord.com', verdict: 'transcribed' }, NOW)).toBe(
      'screenshot of discord.com 30s ago: transcript stored, picture deleted',
    );
    expect(describeVision({ at: NOW, host: 'discord.com', verdict: 'not-in-front' }, NOW)).toBe(
      'screenshot of discord.com just now: skipped, the tab was not in front',
    );
  });

  it('names the level and its floor when candidates were dropped for confidence', () => {
    const base = { at: NOW, host: 'www.google.com', fields: 1, gate: 'ok' as const, cached: false, attempts: [{ id: 'openai' as const, ms: 40, count: 0 }] };
    expect(describeSuggest({ ...base, offered: 0, eagerness: 'eager', underFloor: 2 }, NOW)).toBe(
      'checked just now: openai answered in 40 ms with 0, offered 0, 2 candidates under the eager floor (0.35)',
    );
    expect(describeSuggest({ ...base, offered: 1, eagerness: 'balanced', underFloor: 1, navigation: 1 }, NOW)).toBe(
      'checked just now: openai answered in 40 ms with 0, offered 1, 1 tab offer, 1 candidate under the balanced floor (0.55)',
    );
    expect(describeSuggest({ ...base, offered: 0, eagerness: 'conservative', underFloor: 3, refine: true, smart: true }, NOW)).toBe(
      'checked just now: openai answered in 40 ms with 0, offered 0, 3 candidates under the conservative floor (0.7); smart model asked for a second opinion',
    );
    // Nothing dropped, nothing said; a record from before the setting existed reads as the default.
    expect(describeSuggest({ ...base, offered: 1, eagerness: 'eager' }, NOW)).not.toContain('floor');
    expect(describeSuggest({ ...base, offered: 0, underFloor: 1 }, NOW)).toContain('under the eager floor (0.35)');
  });

  it('notes a smart second opinion on the check line', () => {
    expect(describeSuggest({ at: NOW, host: 'www.google.com', fields: 1, gate: 'ok', cached: false, attempts: [{ id: 'openai', ms: 40, count: 1 }], offered: 1, refine: true, smart: true }, NOW)).toBe(
      'checked just now: openai answered in 40 ms with 1, offered 1; smart model asked for a second opinion',
    );
  });

  it('says what answered first and how long that took, then what came later', () => {
    const base = { at: NOW, host: 'www.google.com', fields: 1, gate: 'ok' as const, cached: false, offered: 1 };
    expect(describeSuggest({ ...base, source: 'local', ms: 4, refine: true }, NOW)).toBe(
      'checked just now: regex pass answered first in 4 ms, offered 1; more may follow',
    );
    expect(describeSuggest({ ...base, source: 'entities', ms: 6, refine: true, refined: 1, attempts: [{ id: 'local', ms: 1, count: 1 }, { id: 'openai', ms: 812, count: 1 }] }, NOW)).toBe(
      'checked just now: entities predicted at capture answered first in 6 ms; local answered in 1 ms with 1; openai answered in 812 ms with 1, offered 1; 1 later answer handed over',
    );
    expect(describeSuggest({ ...base, source: 'chat', ms: 640, attempts: [{ id: 'openai', ms: 640, count: 1 }] }, NOW)).toBe(
      'checked just now: chat model answered first in 640 ms; openai answered in 640 ms with 1, offered 1',
    );
    expect(describeSuggest({ ...base, source: 'prewarm', prewarmed: true }, NOW)).toBe('checked just now: answer was pre-warmed on navigation, offered 1');
  });
});

describe('describePrewarm', () => {
  it('says what a navigation onto a known page pre-warmed', () => {
    expect(describePrewarm({ at: NOW - 3_000, host: 'www.google.com', verdict: 'warmed', count: 1, attempts: [{ id: 'openai', ms: 640, count: 1 }] }, NOW)).toBe(
      'navigation to www.google.com just now: pre-warmed 1 fill (openai, 640 ms)',
    );
    expect(describePrewarm({ at: NOW - 30_000, host: 'calendar.google.com', verdict: 'no-context' }, NOW)).toBe(
      'navigation to calendar.google.com 30s ago: nothing pre-warmed, nothing read in another tab to answer from',
    );
    expect(describePrewarm({ at: NOW, host: 'mail.google.com', verdict: 'failed', attempts: [{ id: 'openai', ms: 6000, count: 0, error: 'timed out' }] }, NOW)).toBe(
      'navigation to mail.google.com just now: provider failed (timed out), nothing cached',
    );
    expect(describePrewarm({ at: NOW, host: 'www.google.com', verdict: 'warm' }, NOW)).toBe(
      'navigation to www.google.com just now: nothing pre-warmed, an answer was already cached or on its way',
    );
  });
});
