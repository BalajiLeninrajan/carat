import { describe, expect, it } from 'vitest';
import { relativeAge } from '../src/format/age';
import { describeCapture, describePerform, describeSuggest, describeVision } from '../src/format/diag';

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
  const base = { at: 1000, host: 'www.google.com', controls: 5 } as const;

  it('says which check stopped a request', () => {
    expect(describeSuggest({ ...base, gate: 'no-snapshot' }, 1000)).toBe('checked just now: no request, nothing on the page to act on');
    expect(describeSuggest({ ...base, gate: 'password' }, 1000)).toContain('the page has a password field');
    expect(describeSuggest({ ...base, gate: 'site-off' }, 1000)).toContain('carat is off for this site');
  });

  it('names what answered, how long it took, and the action it gave', () => {
    const line = describeSuggest(
      {
        ...base,
        gate: 'ok',
        source: 'placeholder',
        ms: 4,
        kind: 'fill',
        label: 'Fill Search with "Seven Shores Cafe"',
        reason: 'the note names the place',
        confidence: 0.5,
        refine: true,
      },
      1000,
    );
    expect(line).toContain('the offline placeholder answered first in 4 ms');
    expect(line).toContain('fill "Fill Search with \"Seven Shores Cafe\"" (0.5)');
    expect(line).toContain('the note names the place');
    expect(line).toContain('more may follow');
  });

  it('says when the model replaced the placeholder, and what each provider did', () => {
    const line = describeSuggest(
      {
        ...base,
        gate: 'ok',
        source: 'model',
        ms: 6,
        attempts: [
          { id: 'local', ms: 2, kind: 'none' },
          { id: 'openai', ms: 812, kind: 'click' },
        ],
        kind: 'click',
        label: 'Click "Order online"',
        confidence: 0.7,
        replaced: true,
      },
      1000,
    );
    expect(line).toContain('local answered in 2 ms with none; openai answered in 812 ms with click');
    expect(line).toContain('the model replaced it');
  });

  it('says a chip was refused, and when one asks for a second Tab', () => {
    expect(describeSuggest({ ...base, gate: 'ok', source: 'model', ms: 9, refused: 'the control is disabled' }, 1000)).toContain(
      'refused: the control is disabled',
    );
    expect(describeSuggest({ ...base, gate: 'ok', source: 'model', ms: 9, kind: 'click', label: 'Send reply', irreversible: true }, 1000)).toContain(
      'asks for a second Tab',
    );
  });

  it('says why there is no chip, and what was retried to avoid it', () => {
    const line = describeSuggest(
      {
        ...base,
        gate: 'ok',
        source: 'fallback',
        ms: 900,
        reasked: 'none',
        kind: 'scroll',
        label: 'Scroll more',
        confidence: 0.4,
      },
      1000,
    );
    expect(line).toContain('nobody answered, so the page’s plainest step stood in');
    expect(line).toContain('asked again after "none"');
    expect(line).not.toContain('no chip');

    const quiet = describeSuggest(
      { ...base, gate: 'ok', source: 'model', ms: 900, reasked: 'none', silent: 'nothing was offered and the page had no plainer step to stand in' },
      1000,
    );
    expect(quiet).toContain('no chip: nothing was offered and the page had no plainer step to stand in');
  });

  it('prints the three moments that decide how fast it feels, and whether the prefix was warm', () => {
    const line = describeSuggest(
      { ...base, gate: 'ok', source: 'placeholder', ms: 4, placeholderMs: 4, partialMs: 210, finalMs: 812, warmed: true, kind: 'click' },
      1000,
    );
    expect(line).toContain('[placeholder 4 ms, target 210 ms, action 812 ms, prefix warmed]');
    expect(describeSuggest({ ...base, gate: 'ok', source: 'model', ms: 9, warmed: false }, 1000)).toContain('[prefix cold]');
    // Nothing timed, nothing printed.
    expect(describeSuggest({ ...base, gate: 'ok', source: 'cache', ms: 0 }, 1000)).not.toContain('[');
  });

  it('says a failed provider, and that the cache answered', () => {
    expect(describeSuggest({ ...base, gate: 'ok', source: 'cache', ms: 0, kind: 'scroll', label: 'Scroll down' }, 1000)).toContain(
      'answer from the 60s cache',
    );
    expect(describeSuggest({ ...base, gate: 'ok', source: 'model', ms: 12, attempts: [{ id: 'openai', ms: 6000, kind: '-', error: 'timed out' }] }, 1000)).toContain(
      'openai failed after 6000 ms (timed out)',
    );
  });
});

describe('describePerform', () => {
  it('names the armed control that was pressed, and the fill that stopped short', () => {
    expect(describePerform({ at: NOW - 12_000, host: 'aircanada.com', kind: 'armed', name: 'Pay $312.40', outcome: 'done' }, NOW)).toBe(
      'pressed "Pay $312.40" on aircanada.com 12s ago (armed, second Tab)',
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
});
