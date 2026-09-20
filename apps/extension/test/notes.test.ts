import { describe, expect, it, vi } from 'vitest';
import type { ContextItem } from '@carat/shared';
import type { NoteDiag } from '../src/background/diag';
import { NOTES_LIMITS, createNotes, fallbackFacts } from '../src/background/notes';
import type { Distill } from '../src/background/notes';
import { describeTabs } from '../src/background/tabs';
import type { StorageArea } from '../src/store';

class FakeArea implements StorageArea {
  data: Record<string, unknown> = {};
  async get(keys: string[]) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.data, structuredClone(items));
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k];
  }
}

const LONG = 'Dinner at Seven Shores Cafe on Friday at 6, and they asked me to bring the returns slip for order NW-55821. '.repeat(3);

let seq = 0;
function item(over: Partial<ContextItem> = {}): ContextItem {
  seq++;
  return {
    id: `i${seq}`,
    tabId: 1,
    origin: 'https://discord.com',
    path: '/channels/1',
    title: 'Waterloo plans',
    kind: 'page',
    text: LONG,
    hash: seq,
    capturedAt: 0,
    lastSeenAt: 0,
    ...over,
  };
}

function setup(distill?: Distill, start = 1_000_000) {
  let clock = start;
  const area = new FakeArea();
  const notes = createNotes({ area, ...(distill ? { distill } : {}), now: () => clock, timeoutMs: 50 });
  return { area, notes, tick: (ms: number) => (clock += ms) };
}

function setupWithDiag(distill: Distill, onDiag: (tabId: number, d: NoteDiag) => void, start = 1_000_000) {
  let clock = start;
  const area = new FakeArea();
  const notes = createNotes({ area, distill, onDiag, now: () => clock, timeoutMs: 50 });
  return { area, notes, tick: (ms: number) => (clock += ms) };
}

const MIN = 60_000;

describe('notes', () => {
  it('distils a page the user left through the injected distiller', async () => {
    const distill = vi.fn<Distill>().mockResolvedValue(['Dinner at Seven Shores Cafe on Friday at 6.']);
    const { notes } = setup(distill);

    await notes.distilNow(item());

    expect(distill).toHaveBeenCalledTimes(1);
    expect(distill.mock.calls[0]![1]).toBe('discord.com');
    expect(await notes.top({ tabId: 9 })).toEqual(['just now: Dinner at Seven Shores Cafe on Friday at 6. (read on discord.com)']);
  });

  it('distils on tab-hide, not on every capture', async () => {
    const distill = vi.fn<Distill>().mockResolvedValue(['A fact.']);
    const { notes } = setup(distill);

    notes.onCapture(item({ hash: 1 }));
    expect(distill).not.toHaveBeenCalled();

    await notes.onTabHidden(1);
    expect(distill).toHaveBeenCalledTimes(1);
  });

  it('keeps at most five facts from one page', async () => {
    const { notes } = setup(async () => Array.from({ length: 9 }, (_, i) => `Fact ${i}`));
    const made = await notes.distilNow(item());
    expect(made).toHaveLength(NOTES_LIMITS.perPage);
  });

  it('falls back to the regex candidates when there is no distiller', async () => {
    const { notes } = setup();
    const made = await notes.distilNow(item({ text: `${LONG} Write to hana@example.com about it.` }));

    expect(made.length).toBeGreaterThan(0);
    expect(made.map((n) => n.text).join(' ')).toContain('hana@example.com');
  });

  it('falls back when the distiller fails, and when it times out', async () => {
    const failing = setup(async () => {
      throw new Error('no network');
    });
    expect((await failing.notes.distilNow(item())).length).toBeGreaterThan(0);

    const hanging = setup((_text, _host, signal) => new Promise<string[]>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    expect((await hanging.notes.distilNow(item())).length).toBeGreaterThan(0);
  });

  it('remembers nothing from a page the user only passed through', async () => {
    const distill = vi.fn<Distill>().mockResolvedValue(['A fact worth keeping.']);
    const seen: NoteDiag[] = [];
    const { notes } = setupWithDiag(distill, (_tabId, d) => seen.push(d));

    // A tab left inside three seconds was on the way somewhere.
    expect(await notes.distilNow(item({ hash: 1, capturedAt: 999_000 }))).toEqual([]);
    // The page that says outright it is on its way somewhere.
    expect(await notes.distilNow(item({ hash: 2, title: 'Redirecting… | Slack' }))).toEqual([]);
    // A title that is the site and nothing else.
    expect(await notes.distilNow(item({ hash: 3, title: 'Slack', origin: 'https://app.slack.com' }))).toEqual([]);
    // The hops in and out of a login.
    expect(await notes.distilNow(item({ hash: 4, path: '/oauth2/callback', origin: 'https://auth.example.com' }))).toEqual([]);
    // And a page with a title and almost no body.
    expect(await notes.distilNow(item({ hash: 5, origin: 'https://short.example', text: 'Loading your workspace.' }))).toEqual([]);

    expect(distill).not.toHaveBeenCalled();
    expect(seen.map((d) => d.verdict)).toEqual(['glanced', 'transient', 'transient', 'auth-page', 'short']);
    expect(await notes.top({ tabId: 9 })).toEqual([]);
  });

  it('drops a distilled line that says no more than the page title or the host', async () => {
    const seen: NoteDiag[] = [];
    const { notes } = setupWithDiag(async () => ['Waterloo plans', 'discord.com'], (_tabId, d) => seen.push(d));
    expect(await notes.distilNow(item({ title: 'Waterloo plans' }))).toEqual([]);
    expect(seen.at(-1)?.verdict).toBe('title-only');
  });

  it('says how many notes a page it did read turned into', async () => {
    const seen: NoteDiag[] = [];
    const { notes } = setupWithDiag(async () => ['Dinner at Seven Shores Cafe.', 'Bring the returns slip.'], (_tabId, d) => seen.push(d));
    await notes.distilNow(item());
    expect(seen.at(-1)).toMatchObject({ verdict: 'kept', kept: 2, host: 'discord.com' });
  });

  it('drops a note once it is an hour old', async () => {
    const { notes, tick } = setup(async () => ['A fact worth keeping.']);
    await notes.distilNow(item());

    tick(59 * MIN);
    expect(await notes.top({ tabId: 9 })).toHaveLength(1);
    tick(2 * MIN);
    expect(await notes.top({ tabId: 9 })).toEqual([]);
  });

  it('does not repeat the same fact, however many pages say it', async () => {
    const { notes } = setup(async () => ['Dinner at Seven Shores Cafe.']);
    await notes.distilNow(item({ origin: 'https://discord.com', hash: 1 }));
    await notes.distilNow(item({ origin: 'https://mail.example.com', tabId: 2, hash: 2 }));

    expect(await notes.top({ tabId: 9 })).toHaveLength(1);
  });

  it('lets a fresh reading of a page replace what that page said before', async () => {
    let answer = ['The old plan: Tuesday.'];
    const { notes } = setup(async () => answer);
    await notes.distilNow(item({ hash: 1 }));
    answer = ['The new plan: Friday.'];
    await notes.distilNow(item({ hash: 2 }));

    expect(await notes.top({ tabId: 9 })).toEqual(['just now: The new plan: Friday. (read on discord.com)']);
  });

  it('never reads the same text twice', async () => {
    const distill = vi.fn<Distill>().mockResolvedValue(['A fact.']);
    const { notes } = setup(distill);
    await notes.distilNow(item({ hash: 7 }));
    await notes.distilNow(item({ hash: 7 }));

    expect(distill).toHaveBeenCalledTimes(1);
  });

  it('puts other tabs first and marks what this tab read itself', async () => {
    const { notes, tick } = setup();
    await notes.distilNow(item({ tabId: 1, origin: 'https://discord.com', hash: 1, text: `${LONG} Write to hana@example.com.` }));
    tick(MIN);
    await notes.distilNow(item({ tabId: 2, origin: 'https://mail.example.com', hash: 2, text: `${LONG} Write to raj@example.com.` }));

    const top = await notes.top({ tabId: 1 });
    expect(top[0]).toContain('raj@example.com');
    expect(top[0]).toContain('read on mail.example.com');
    expect(top.find((line) => line.includes('hana@example.com'))).toContain('(this tab)');
  });

  it('opens every line with how old the note is, so the model can weigh it', async () => {
    const { notes, tick } = setup(async () => ['Dinner at Seven Shores Cafe on Friday at 6.']);
    await notes.distilNow(item({ tabId: 1, hash: 1 }));
    tick(3 * MIN);
    expect((await notes.top({ tabId: 9 }))[0]).toBe('3m ago: Dinner at Seven Shores Cafe on Friday at 6. (read on discord.com)');
    tick(39 * MIN);
    expect((await notes.top({ tabId: 9 }))[0]).toBe('42m ago: Dinner at Seven Shores Cafe on Friday at 6. (read on discord.com)');
  });

  it('carries two notes from over half an hour ago and no more', async () => {
    let site = 0;
    const { notes, tick } = setup(async () => [`Fact ${site}`]);
    // Six pages read at five-minute intervals, then the user reads nothing for
    // half an hour: the first four are old news by the time they act.
    for (site = 0; site < 6; site++) {
      await notes.distilNow(item({ origin: `https://site${site}.example`, tabId: site + 10, hash: site }));
      tick(5 * MIN);
    }
    tick(15 * MIN);

    const top = await notes.top({ tabId: 1 });
    const old = top.filter((line) => /\b(3[0-9]|[4-9][0-9])m ago|h ago/.test(line));
    expect(old).toHaveLength(NOTES_LIMITS.oldMax);
    // The two kept are the newest of the old ones, and every fresh one is there.
    expect(old[0]).toContain('Fact 3');
    expect(old[1]).toContain('Fact 2');
    expect(top.filter((line) => /Fact [45]/.test(line))).toHaveLength(2);
    expect(top.some((line) => /Fact [01]\b/.test(line))).toBe(false);
  });

  it('carries at most eight lines, newest first', async () => {
    let site = 0;
    const { notes, tick } = setup(async () => Array.from({ length: 5 }, (_, j) => `Fact ${site}-${j}`));
    for (site = 0; site < 4; site++) {
      await notes.distilNow(item({ origin: `https://site${site}.example`, tabId: site + 10, hash: site }));
      tick(MIN);
    }
    const top = await notes.top({ tabId: 1 });
    expect(top).toHaveLength(NOTES_LIMITS.top);
    expect(top[0]).toContain('Fact 3-');
  });

  it('remembers nothing while the store is pinned', async () => {
    const area = new FakeArea();
    const notes = createNotes({ area, distill: async () => ['A fact.'], pinned: async () => true });
    expect(await notes.distilNow(item())).toEqual([]);
  });

  it('ignores a selection and a page too thin to be worth reading', async () => {
    const distill = vi.fn<Distill>().mockResolvedValue(['A fact.']);
    const { notes } = setup(distill);
    await notes.distilNow(item({ kind: 'selection' }));
    await notes.distilNow(item({ text: 'too short' }));

    expect(distill).not.toHaveBeenCalled();
  });
});

describe('fallbackFacts', () => {
  it('writes the regex candidates out as short facts naming the page', () => {
    const facts = fallbackFacts({ id: 'i1', kind: 'page', title: 'Waterloo plans', text: 'Dinner at Seven Shores Cafe. Mail hana@example.com.' });
    expect(facts.join(' ')).toContain('email address mentioned: hana@example.com');
    expect(facts.join(' ')).toContain('(on "Waterloo plans")');
  });
});

describe('describeTabs', () => {
  it('names the tabs the user could switch to, and leaves out the rest', () => {
    expect(
      describeTabs(
        [
          { id: 1, url: 'https://maps.google.com/', title: 'Google Maps' },
          { id: 2, url: 'chrome://extensions', title: 'Extensions' },
          { id: 3, url: 'https://www.rbcroyalbank.com/', title: 'Banking' },
          { id: 4, url: 'https://discord.com/channels/1', title: 'Waterloo plans' },
          { url: 'https://example.com/', title: 'No id' },
        ],
        4,
      ),
    ).toEqual([{ id: 1, host: 'maps.google.com', title: 'Google Maps' }]);
  });
});
