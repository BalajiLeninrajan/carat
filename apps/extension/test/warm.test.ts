import { describe, expect, it, vi } from 'vitest';
import type { NextActionRequest, Settings } from '@carat/shared';
import { DEFAULT_SETTINGS, WARMUP_OUTLINE, buildNextActionMessages, renderPrefix } from '@carat/shared';
import type { Provider } from '@carat/providers';
import {
  KEEP_WARM_ALARM,
  KEEP_WARM_PERIOD_MINUTES,
  WARM_LIMITS,
  createKeepWarm,
  createWarmer,
  newestMark,
} from '../src/background/warm';
import { HISTORY_KEY } from '../src/background/history';
import { NOTES_KEY } from '../src/background/notes';
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

const committed = (over: Partial<{ tabId: number; frameId: number; url: string }> = {}) => ({
  tabId: 7,
  frameId: 0,
  url: 'https://www.google.com/maps',
  ...over,
});

const NOTES = ['Alex asked about dinner at Seven Shores Cafe on Friday at 6.'];

function setup(
  over: {
    settings?: Partial<Settings>;
    notes?: string[];
    history?: string[];
    goal?: string;
    warm?: (req: NextActionRequest, opts: { signal: AbortSignal }) => Promise<void>;
  } = {},
) {
  let clock = 1_000_000;
  const seen: NextActionRequest[] = [];
  const signals: AbortSignal[] = [];
  const provider: Provider = {
    id: 'openai',
    next: async () => null,
    warm: async (req, opts) => {
      seen.push(req);
      signals.push(opts.signal);
      return over.warm?.(req, opts);
    },
  };
  const warmer = createWarmer({
    settings: async () => ({ ...DEFAULT_SETTINGS, apiKey: 'k', ...over.settings }),
    notes: async () => over.notes ?? NOTES,
    history: async () => over.history ?? [],
    tabs: async () => [{ id: 8, host: 'discord.com', title: 'Discord' }],
    goal: async () => over.goal,
    createProvider: () => provider,
    now: () => clock,
  });
  return { warmer, seen, signals, tick: (ms: number) => (clock += ms), at: () => clock };
}

describe('the navigation warm-up', () => {
  it('sends the prefix the real request will send, with a placeholder where the outline goes', async () => {
    const { warmer, seen } = setup();
    await warmer.onCommitted(committed());
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.outline).toBe(WARMUP_OUTLINE);
    expect(req.controls).toEqual([]);
    expect(req.notes).toEqual(NOTES);
    expect(req.page).toMatchObject({ host: 'www.google.com', path: '/maps' });

    // The real request on that page carries the same prefix, byte for byte.
    const real = { ...req, outline: 'search:\n  [1] searchbox "Search Google Maps"', controls: [{ n: 1, role: 'searchbox' as const, name: 'Search' }] };
    expect(renderPrefix(real)).toBe(renderPrefix(req));
    expect(JSON.stringify(buildNextActionMessages(real).slice(0, -1))).toBe(JSON.stringify(buildNextActionMessages(req).slice(0, -1)));
  });

  it('warms the goal with the rest, so the real request on the page still hits the cache', async () => {
    const goal = 'book a flight ZRH to LON on Friday, cheapest';
    const { warmer, seen } = setup({ goal });
    await warmer.onCommitted(committed());
    const req = seen[0]!;
    expect(req.goal).toBe(goal);

    const real = { ...req, outline: 'search:\n  [1] searchbox "Search"', controls: [{ n: 1, role: 'searchbox' as const, name: 'Search' }] };
    expect(renderPrefix(real)).toBe(renderPrefix(req));
    expect(warmer.warmed(7, real)).toBe(true);
    // A goal that moved on in between is a prefix the provider has not seen.
    expect(warmer.warmed(7, { ...real, goal: 'find brunch in Waterloo' })).toBe(false);
  });

  it('warms a tab at most once every thirty seconds', async () => {
    const { warmer, seen, tick } = setup();
    await warmer.onCommitted(committed());
    await warmer.onCommitted(committed({ url: 'https://www.google.com/maps/search/cafe' }));
    expect(seen).toHaveLength(1);
    tick(WARM_LIMITS.perTabMs + 1);
    await warmer.onCommitted(committed({ url: 'https://www.google.com/maps/search/cafe' }));
    expect(seen).toHaveLength(2);
  });

  it('leaves another tab free to warm on its own', async () => {
    const { warmer, seen } = setup();
    await warmer.onCommitted(committed());
    await warmer.onCommitted(committed({ tabId: 9 }));
    expect(seen).toHaveLength(2);
  });

  it('skips a sub-frame, a chrome page and anything that is not http', async () => {
    const { warmer, seen } = setup();
    await warmer.onCommitted(committed({ frameId: 3 }));
    await warmer.onCommitted(committed({ tabId: 2, url: 'chrome://extensions' }));
    await warmer.onCommitted(committed({ tabId: 3, url: 'about:blank' }));
    await warmer.onCommitted(committed({ tabId: -1 }));
    expect(seen).toEqual([]);
  });

  it('respects the global switch, the per-site switch and the denylist', async () => {
    const off = setup({ settings: { enabled: false } });
    await off.warmer.onCommitted(committed());
    expect(off.seen).toEqual([]);

    const site = setup({ settings: { disabledHosts: ['www.google.com'] } });
    await site.warmer.onCommitted(committed());
    expect(site.seen).toEqual([]);

    const bank = setup();
    await bank.warmer.onCommitted(committed({ url: 'https://www.rbcroyalbank.com/' }));
    expect(bank.seen).toEqual([]);
  });

  it('does not warm a prefix with nothing in it', async () => {
    const { warmer, seen } = setup({ notes: [], history: [] });
    await warmer.onCommitted(committed());
    expect(seen).toEqual([]);

    const withHistory = setup({ notes: [], history: ['40s ago: clicked button "Add to cart"'] });
    await withHistory.warmer.onCommitted(committed());
    expect(withHistory.seen).toHaveLength(1);
  });

  it('gives up after three seconds', async () => {
    vi.useFakeTimers();
    try {
      const { warmer, signals } = setup({ warm: (_req, opts) => new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve())) });
      const pending = warmer.onCommitted(committed());
      await vi.advanceTimersByTimeAsync(WARM_LIMITS.abortMs + 1);
      await pending;
      expect(signals[0]!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never raises what the provider throws', async () => {
    const { warmer } = setup({ warm: async () => { throw new Error('offline'); } });
    await expect(warmer.onCommitted(committed())).resolves.toBeUndefined();
  });

  it('says a prefix was warmed only while it is still the prefix', async () => {
    const { warmer, seen, tick } = setup();
    await warmer.onCommitted(committed());
    const req = seen[0]!;
    expect(warmer.warmed(7, req)).toBe(true);
    expect(warmer.warmed(9, req)).toBe(false);
    // A note landed in between, so the bytes the provider cached are not these ones.
    expect(warmer.warmed(7, { ...req, notes: [...req.notes, 'Something else was read.'] })).toBe(false);
    tick(WARM_LIMITS.freshWarmMs + 1);
    expect(warmer.warmed(7, req)).toBe(false);
  });
});

describe('the keep-warm tick', () => {
  function alarms() {
    const created: Array<{ name: string; periodInMinutes: number }> = [];
    const cleared: string[] = [];
    let live: string | undefined;
    return {
      created,
      cleared,
      api: {
        create(name: string, info: { periodInMinutes: number }) {
          created.push({ name, ...info });
          live = name;
        },
        clear(name: string) {
          cleared.push(name);
          live = undefined;
          return true;
        },
        async get(name: string) {
          return live === name ? { name } : undefined;
        },
      },
    };
  }

  const keep = (area: StorageArea, a: ReturnType<typeof alarms>, now: () => number) =>
    createKeepWarm({ alarms: a.api, area, now });

  it('ticks every half minute while a note or a timeline entry is under thirty minutes old', async () => {
    const area = new FakeArea();
    let clock = 1_000_000;
    const a = alarms();
    const k = keep(area, a, () => clock);

    expect(await k.check()).toBe(false);
    expect(a.created).toEqual([]);

    area.data[NOTES_KEY] = [{ at: clock, origin: 'https://discord.com', tabId: 8, title: '', text: 'Dinner Friday' }];
    expect(await k.check()).toBe(true);
    expect(a.created).toEqual([{ name: KEEP_WARM_ALARM, periodInMinutes: KEEP_WARM_PERIOD_MINUTES }]);

    // A tick while the note is still fresh keeps it, and does not stack a second alarm.
    clock += 60_000;
    expect(await k.onTick()).toBe(true);
    expect(a.created).toHaveLength(1);

    clock += WARM_LIMITS.materialMs;
    expect(await k.onTick()).toBe(false);
    expect(a.cleared).toEqual([KEEP_WARM_ALARM]);
  });

  it('counts the timeline too', async () => {
    const area = new FakeArea();
    let clock = 1_000_000;
    const a = alarms();
    area.data[HISTORY_KEY] = { '7': [{ t: clock - 60_000, kind: 'click', role: 'button', name: 'Add to cart' }] };
    expect(await keep(area, a, () => clock).check()).toBe(true);
  });

  it('reads the newest mark out of either store, and neither', async () => {
    const area = new FakeArea();
    expect(await newestMark(area)).toBe(Number.NEGATIVE_INFINITY);
    area.data[NOTES_KEY] = [{ at: 10 }, { at: 40 }, 'rubbish'];
    area.data[HISTORY_KEY] = { '7': [{ t: 90 }], '8': 'rubbish' };
    expect(await newestMark(area)).toBe(90);
  });
});
