import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Eagerness, NextAction, NextActionRequest, OpenTab, OutlineControl, Settings } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
import type { NextOptions, Provider } from '@carat/providers';
import { RefineQueue } from '../src/background/refine';
import type { SuggestDiag } from '../src/background/diag';
import { clearActionCache, nextAction, pick, validate } from '../src/background/orchestrate';
import type { PageSnapshot } from '../src/messaging';

const CONTROLS: OutlineControl[] = [
  { n: 1, role: 'searchbox', name: 'Search Google Maps' },
  { n: 2, role: 'button', name: 'Directions' },
  { n: 3, role: 'button', name: 'Pay $312.40', risky: true },
];

const snapshot = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps', scroll: { y: 0, pages: 1, more: false } },
  outline: 'search:\n  >> FOCUSED [1] searchbox "Search Google Maps"',
  controls: CONTROLS,
  focused: 1,
  ...over,
});

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, apiKey: 'k', ...over });

const action = (over: Partial<NextAction> = {}): NextAction => ({
  kind: 'click',
  target: 2,
  value: '',
  label: 'Click "Directions"',
  irreversible: false,
  confidence: 0.8,
  reason: 'the next step',
  ...over,
});

class Fixed implements Provider {
  readonly id = 'openai' as const;
  constructor(
    private readonly answer: NextAction | null,
    private readonly delayMs = 0,
    private readonly target?: number,
  ) {}

  async next(_req: NextActionRequest, opts: NextOptions): Promise<NextAction | null> {
    if (this.target !== undefined) opts.onPartial?.({ target: this.target });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.answer;
  }
}

const nothing: Provider = { id: 'local', next: async () => null };

const request = (over: Partial<NextActionRequest> = {}): NextActionRequest => ({
  page: snapshot().page,
  outline: snapshot().outline,
  controls: CONTROLS,
  focused: 1,
  history: [],
  notes: [],
  tabs: [{ id: 8, host: 'discord.com', title: 'Discord' }],
  now: '2026-09-16T14:04:00-04:00',
  eagerness: 'eager',
  ...over,
});

beforeEach(() => {
  clearActionCache();
});

describe('one action per page', () => {
  it('gates on the switches, the denylist and a password field', async () => {
    const seen: string[] = [];
    const deps = {
      settings: async () => settings(),
      createProvider: () => new Fixed(action()),
      localProvider: nothing,
      onDiag: (d: { gate: string }) => seen.push(d.gate),
    };
    expect((await nextAction(snapshot(), { tabId: 1, origin: 'x' }, { ...deps, settings: async () => settings({ enabled: false }) })).action).toBeNull();
    expect((await nextAction(snapshot({ page: { ...snapshot().page, host: 'www.rbcroyalbank.com' } }), { tabId: 1, origin: 'x' }, deps)).action).toBeNull();
    expect((await nextAction(snapshot({ password: true }), { tabId: 1, origin: 'x' }, deps)).action).toBeNull();
    expect(seen).toEqual(['disabled', 'denylisted', 'password']);
  });

  it('answers with the placeholder at once and replaces it through the ticket', async () => {
    const refine = new RefineQueue({ setTimer: () => undefined });
    const placeholder = action({ kind: 'fill', target: 1, value: 'Seven Shores Cafe', confidence: 0.5, label: 'Fill Search with "Seven Shores Cafe"' });
    const model = action({ confidence: 0.8 });
    const res = await nextAction(snapshot(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: new Fixed(placeholder),
      createProvider: () => new Fixed(model, 0, 2),
      refine,
    });
    expect(res.action?.value).toBe('Seven Shores Cafe');
    expect(res.ticket).toBeDefined();
    // The ring moves first, then the action itself.
    expect(await refine.claim(res.ticket!, 1)).toMatchObject({ target: 2, more: true });
    expect(await refine.claim(res.ticket!, 1)).toMatchObject({ action: { label: 'Click "Directions"' } });
  });

  it('keeps a surer context-backed fill over the model', async () => {
    const refine = new RefineQueue({ setTimer: () => undefined });
    const placeholder = action({ kind: 'fill', target: 1, value: 'Seven Shores Cafe', confidence: 0.9 });
    const res = await nextAction(snapshot(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: new Fixed(placeholder),
      createProvider: () => new Fixed(action({ confidence: 0.6 })),
      refine,
    });
    expect(res.action?.value).toBe('Seven Shores Cafe');
    // Nothing better ever lands, so the ticket closes with no action on it.
    expect(await refine.claim(res.ticket!, 1)).toEqual({});
  });

  it('waits for the model when there is no ticket to answer later on', async () => {
    const res = await nextAction(snapshot(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => new Fixed(action()),
    });
    expect(res.action?.label).toBe('Click "Directions"');
    expect(res.ticket).toBeUndefined();
  });

  it('offers a Pay now control with a second Tab instead of refusing it', async () => {
    const diags: Array<{ refused?: string; irreversible?: boolean }> = [];
    const res = await nextAction(snapshot(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => new Fixed(action({ target: 3, label: 'Click "Pay now"' })),
      onDiag: (d) => diags.push(d),
    });
    expect(res.action?.target).toBe(3);
    expect(res.action?.irreversible).toBe(true);
    expect(diags.every((d) => d.refused === undefined)).toBe(true);
  });

  it('answers a second identical page from the cache, and not after a force', async () => {
    const provider = vi.fn(() => new Fixed(action()));
    const deps = { settings: async () => settings(), localProvider: nothing, createProvider: provider };
    await nextAction(snapshot(), { tabId: 1, origin: 'x' }, deps);
    await nextAction(snapshot(), { tabId: 1, origin: 'x' }, deps);
    expect(provider).toHaveBeenCalledTimes(1);
    await nextAction(snapshot({ force: true }), { tabId: 1, origin: 'x' }, deps);
    expect(provider).toHaveBeenCalledTimes(2);
  });
});

describe('validation is safety only', () => {
  const s = settings();

  it('refuses a control that is not on the page, and a disabled one', () => {
    expect(validate(action({ target: 99 }), request(), s)).toBeNull();
    const disabled: OutlineControl[] = [{ n: 4, role: 'button', name: 'Continue', state: 'disabled' }];
    expect(validate(action({ target: 4 }), request({ controls: disabled }), s)).toBeNull();
  });

  it('flags a control that takes money like any other irreversible one, and refuses nothing', () => {
    const pay = action({ target: 3, label: 'Click "Pay $312.40"' });
    const checked = validate(pay, request(), s);
    expect(checked).not.toBeNull();
    expect(checked?.irreversible).toBe(true);
    expect(checked?.label).toBe('Click "Pay $312.40"');
  });

  it('marks an action irreversible from the model, the label or the control', () => {
    expect(validate(action({ label: 'Click "Send reply"' }), request(), s)?.irreversible).toBe(true);
    expect(validate(action({ irreversible: true }), request(), s)?.irreversible).toBe(true);
    expect(validate(action(), request(), s)?.irreversible).toBe(false);
  });

  it('never fills a control with its own name, or with nothing', () => {
    expect(validate(action({ kind: 'fill', target: 1, value: 'Search Google Maps' }), request(), s)).toBeNull();
    expect(validate(action({ kind: 'fill', target: 1, value: '' }), request(), s)).toBeNull();
    expect(validate(action({ kind: 'fill', target: 1, value: 'Seven Shores Cafe' }), request(), s)?.value).toBe('Seven Shores Cafe');
  });

  it('scrolls only when there is more page below', () => {
    const scroll = action({ kind: 'scroll', target: null, label: 'Scroll down' });
    expect(validate(scroll, request(), s)).toBeNull();
    const more = request({ page: { ...request().page, scroll: { y: 0.4, pages: 3, more: true } } });
    expect(validate(scroll, more, s)?.kind).toBe('scroll');
  });

  it('opens only what the intent registry can build, never a URL the model wrote', () => {
    const open = (value: string) => validate(action({ kind: 'open', target: null, value, label: 'Open Maps' }), request(), s);
    expect(open('maps:Seven Shores Cafe')?.kind).toBe('open');
    expect(open('https://evil.test/')).toBeNull();
    expect(open('slack:#general')).toBeNull();
  });

  it('switches only to a tab that is open', () => {
    const to = (value: string) => validate(action({ kind: 'switch', target: null, value, label: 'Switch to Discord' }), request(), s);
    expect(to('8')?.kind).toBe('switch');
    expect(to('99')).toBeNull();
  });

  it('applies the level’s floor, and takes no "none" from anyone', () => {
    const levels: Array<[Eagerness, number, boolean]> = [
      ['eager', 0.4, true],
      ['balanced', 0.4, false],
      ['conservative', 0.6, false],
    ];
    for (const [eagerness, confidence, kept] of levels) {
      const got = validate(action({ confidence }), request({ eagerness }), s);
      expect(Boolean(got), `${eagerness} at ${confidence}`).toBe(kept);
    }
    expect(validate(action({ kind: 'none', target: null, confidence: 0 }), request({ eagerness: 'eager' }), s)).toBeNull();
  });

  it('names the open tabs the model may switch to, and leaves the asking tab out', async () => {
    let seen: NextActionRequest | undefined;
    const spy: Provider = {
      id: 'openai',
      next: async (req) => {
        seen = req;
        return null;
      },
    };
    const tabs: OpenTab[] = [
      { id: 1, host: 'www.google.com', title: 'Maps' },
      { id: 8, host: 'discord.com', title: 'Discord' },
    ];
    await nextAction(snapshot(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => spy,
      tabs: async () => tabs,
      history: { lines: async () => ['40s ago: clicked button "Add to cart"'] },
      notes: { lines: async () => ['Dinner at Seven Shores Cafe on Friday at 6.'] },
    });
    expect(seen?.tabs).toEqual([{ id: 8, host: 'discord.com', title: 'Discord' }]);
    expect(seen?.history).toEqual(['40s ago: clicked button "Add to cart"']);
    expect(seen?.notes).toEqual(['Dinner at Seven Shores Cafe on Friday at 6.']);
  });
});

describe('how fast the chip goes up', () => {
  it('answers inside 50 ms with a two-second model, and lands the model through the ticket', async () => {
    // Only the timers the fake model and the ticket use; the clock stays real so the 50 ms means something.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const refine = new RefineQueue({ setTimer: () => undefined });
      const placeholder = action({ kind: 'fill', target: 1, value: 'Seven Shores Cafe', confidence: 0.5, label: 'Fill Search with "Seven Shores Cafe"' });
      const diags: SuggestDiag[] = [];
      const started = Date.now();
      const res = await nextAction(snapshot(), { tabId: 1, origin: 'x' }, {
        settings: async () => settings(),
        localProvider: new Fixed(placeholder),
        createProvider: () => new Fixed(action({ confidence: 0.9 }), 2000, 2),
        refine,
        warmed: () => true,
        onDiag: (d) => diags.push(d),
      });
      expect(Date.now() - started).toBeLessThan(50);
      expect(res.action?.value).toBe('Seven Shores Cafe');
      expect(res.ticket).toBeDefined();
      expect(diags[0]?.placeholderMs).toBeLessThan(50);
      expect(diags[0]?.warmed).toBe(true);

      // The ring is already queued; the model itself is still two seconds out.
      expect(await refine.claim(res.ticket!, 1)).toMatchObject({ target: 2, more: true });
      const later = refine.claim(res.ticket!, 1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await later).toMatchObject({ action: { label: 'Click "Directions"', confidence: 0.9 } });
      expect(diags.at(-1)?.finalMs).toBeGreaterThanOrEqual(0);
      expect(diags.at(-1)?.partialMs).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pick', () => {
  it('prefers the model, except against a surer context-backed fill', () => {
    const fill = action({ kind: 'fill', confidence: 0.9 });
    const model = action({ confidence: 0.6 });
    expect(pick(fill, model)).toBe(fill);
    expect(pick(action({ kind: 'fill', confidence: 0.4 }), model)).toBe(model);
    expect(pick(null, model)).toBe(model);
    expect(pick(fill, null)).toBe(fill);
    expect(pick(null, null)).toBeNull();
  });
});
