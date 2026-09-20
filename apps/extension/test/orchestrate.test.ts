import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Eagerness, NextAction, NextActionRequest, OpenTab, OutlineControl, Settings } from '@carat/shared';
import { DEFAULT_SETTINGS, EXAMPLE_VALUES } from '@carat/shared';
import type { NextOptions, Provider } from '@carat/providers';
import { RefineQueue } from '../src/background/refine';
import type { SuggestDiag } from '../src/background/diag';
import { A_LABEL, FROM_AN_EXAMPLE, UNGROUNDED, clearActionCache, nextAction, nudgeLine, pick, validate } from '../src/background/orchestrate';
import { LAST_RESORT_CONFIDENCE, lastResort } from '../src/background/last-resort';
import type { PageSnapshot } from '../src/messaging';

const CONTROLS: OutlineControl[] = [
  { n: 1, role: 'searchbox', name: 'Search Google Maps' },
  { n: 2, role: 'button', name: 'Directions' },
  { n: 3, role: 'button', name: 'Pay $312.40', risky: true },
];

const READ_NOTE = '2m ago: Dinner at Seven Shores Cafe on Friday at 6. (read on discord.com)';

/** A fill is only allowed a value the user read or typed; these deps supply the reading. */
const fromNotes = { lines: async () => [READ_NOTE] };

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

/**
 * The page from the owner's screenshot: the Reddit feed, nothing focused,
 * a Slack tab still calling itself "Redirecting… | Slack", and a note made
 * out of that title. The chip read Fill Search Reddit with "Redirecting… |
 * Slack".
 */
const FEED_OUTLINE = `banner:
  [1] searchbox "Search Reddit"
main:
  heading(1) "Popular posts"
  text: Where is the best brunch in town?
  [2] link "Where is the best brunch in town?"
  [3] button "Join"
(2.4 more screens below; 31 controls not shown)`;

const FEED_CONTROLS: OutlineControl[] = [
  { n: 1, role: 'searchbox', name: 'Search Reddit' },
  { n: 2, role: 'link', name: 'Where is the best brunch in town?' },
  { n: 3, role: 'button', name: 'Join' },
];

const FEED_PAGE = { host: 'www.reddit.com', title: 'Reddit — the front page', path: '/', scroll: { y: 0, pages: 3.4, more: true } };
const SLACK_TAB: OpenTab = { id: 8, host: 'app.slack.com', title: 'Redirecting… | Slack' };
const SLACK_NOTE = '2m ago: Redirecting… | Slack (read on app.slack.com)';

const feedSnapshot = (): PageSnapshot => ({ page: FEED_PAGE, outline: FEED_OUTLINE, controls: FEED_CONTROLS, focused: undefined });

const redditFeed = (over: Partial<NextActionRequest> = {}): NextActionRequest =>
  request({ page: FEED_PAGE, outline: FEED_OUTLINE, controls: FEED_CONTROLS, focused: undefined, notes: [SLACK_NOTE], tabs: [SLACK_TAB], ...over });

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
      notes: fromNotes,
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
      notes: fromNotes,
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
    expect(validate(action({ kind: 'fill', target: 1, value: 'Seven Shores Cafe' }), request({ notes: [READ_NOTE] }), s)?.value).toBe('Seven Shores Cafe');
  });

  it('refuses a fill nothing the user read, did or typed accounts for', () => {
    const made_up = action({ kind: 'fill', target: 1, value: 'Quarry Lane Tavern' });
    expect(validate(made_up, request(), s)).toBeNull();
    const diag: SuggestDiag = { at: 0, host: 'x', controls: 3, gate: 'ok', eagerness: 'eager' };
    validate(made_up, request(), s, diag);
    expect(diag.refused).toBe(UNGROUNDED);
  });

  it('takes the value from a note, a timeline line, the page or the field the user is typing in', () => {
    const fill = (value: string) => action({ kind: 'fill', target: 1, value });
    expect(validate(fill('Seven Shores Cafe'), request({ notes: [READ_NOTE] }), s)?.value).toBe('Seven Shores Cafe');
    expect(validate(fill('ABX-4417'), request({ history: ['1m ago: read order ABX-4417'] }), s)?.value).toBe('ABX-4417');
    const onPage = request({ outline: 'main:\n  text: platform 9 3/4\n  [1] textbox "Platform"' });
    expect(validate(fill('platform 9 3/4'), onPage, s)?.value).toBe('platform 9 3/4');
    const typing = request({ controls: [{ n: 1, role: 'searchbox', name: 'Search', value: 'quarry lane tavern, 7pm' }] });
    expect(validate(fill('Quarry Lane Tavern'), typing, s)?.value).toBe('Quarry Lane Tavern');
    expect(validate(fill('Quarry Lane Bakery'), typing, s)).toBeNull();
  });

  it('refuses a value lifted out of the prompt’s own examples, however well it reads', () => {
    const diag: SuggestDiag = { at: 0, host: 'x', controls: 3, gate: 'ok', eagerness: 'eager' };
    for (const value of EXAMPLE_VALUES) {
      // Even with the example value sitting in a note, which is what a model
      // that had copied its homework would produce.
      expect(validate(action({ kind: 'fill', target: 1, value }), request({ notes: [`Dinner at ${value}.`] }), s, diag)).toBeNull();
      expect(diag.refused).toBe(FROM_AN_EXAMPLE);
    }
  });

  it('refuses a page name, a tab name or a site name as a value to type', () => {
    const feed = redditFeed();
    const diag: SuggestDiag = { at: 0, host: 'www.reddit.com', controls: 3, gate: 'ok', eagerness: 'eager' };
    for (const value of ['Redirecting… | Slack', 'Slack', 'app.slack.com', 'reddit', 'Reddit — the front page']) {
      expect(validate(action({ kind: 'fill', target: 1, value }), feed, s, diag), value).toBeNull();
    }
    expect(diag.refused).toBe(A_LABEL);
  });

  it('fills a search box the user is not in only from their typing or a fresh note from elsewhere', () => {
    const fill = (value: string) => action({ kind: 'fill', target: 1, value });
    const outline = 'banner:\n  [1] searchbox "Search Reddit"\nmain:\n  text: quarry lane tavern is worth a visit\n  [2] link "Best brunch"';
    const page = { ...request().page, host: 'www.reddit.com', title: 'reddit' };
    const unfocused = (over: Partial<NextActionRequest> = {}) =>
      request({ page, outline, controls: [{ n: 1, role: 'searchbox', name: 'Search Reddit' }], focused: undefined, tabs: [], ...over });

    // On the page, so grounded, and still not a reason to search for it.
    expect(validate(fill('quarry lane tavern'), unfocused(), s)).toBeNull();
    // A note from another site, read in the last ten minutes: that is a reason.
    expect(validate(fill('quarry lane tavern'), unfocused({ notes: ['4m ago: Dinner at quarry lane tavern. (read on app.slack.com)'] }), s)?.kind).toBe('fill');
    // The same note, gone cold.
    expect(validate(fill('quarry lane tavern'), unfocused({ notes: ['40m ago: Dinner at quarry lane tavern. (read on app.slack.com)'] }), s)).toBeNull();
    // And the same note, read on the site being searched.
    expect(validate(fill('quarry lane tavern'), unfocused({ notes: ['4m ago: Dinner at quarry lane tavern. (read on www.reddit.com)'] }), s)).toBeNull();
    // What the user has typed on this page always counts.
    const typed = unfocused({ controls: [{ n: 1, role: 'searchbox', name: 'Search Reddit', value: 'quarry lane tav' }] });
    expect(validate(fill('quarry lane tav'), typed, s)).toBeNull(); // the field's own value
    expect(validate(fill('quarry lane'), typed, s)?.kind).toBe('fill');
    // And the box the user is actually in is theirs to fill.
    expect(validate(fill('quarry lane tavern'), unfocused({ focused: 1 }), s)?.kind).toBe('fill');
  });

  it('leaves a select alone: its value is an option, which is on the page', () => {
    const controls: OutlineControl[] = [{ n: 1, role: 'combobox', name: 'Size' }];
    const page = request({ controls, focused: undefined, outline: 'main:\n  [1] combobox "Size": Small, Medium, Large' });
    expect(validate(action({ kind: 'select', target: 1, value: 'Medium' }), page, s)?.value).toBe('Medium');
  });

  it('scrolls only when there is more page below', () => {
    const scroll = action({ kind: 'scroll', target: null, label: 'Scroll down' });
    expect(validate(scroll, request(), s)).toBeNull();
    const more = request({ page: { ...request().page, scroll: { y: 0.4, pages: 3, more: true } } });
    expect(validate(scroll, more, s)?.kind).toBe('scroll');
  });

  it('calls the scroll after the first one "Scroll more", and leaves the model’s own words alone', () => {
    const bare = action({ kind: 'scroll', target: null, label: '' });
    const top = request({ page: { ...request().page, scroll: { y: 0, pages: 3, more: true } } });
    const partway = request({ page: { ...request().page, scroll: { y: 1, pages: 3, more: true } } });
    expect(validate(bare, top, s)?.label).toBe('Scroll down');
    expect(validate(bare, partway, s)?.label).toBe('Scroll more');
    // The model said what it wanted said; the fallback is only for an empty label.
    expect(validate(action({ kind: 'scroll', target: null, label: 'Read the rest of the review' }), partway, s)?.label).toBe('Read the rest of the review');
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
      // Answering nothing at eager buys a second call with a line of its own
      // in the timeline; what this test is about is the first one.
      next: async (req) => {
        seen ??= req;
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
        notes: fromNotes,
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

describe('never silent at eager', () => {
  const scrollable = (over: Partial<PageSnapshot> = {}): PageSnapshot =>
    snapshot({ page: { ...snapshot().page, scroll: { y: 0.4, pages: 3, more: true } }, ...over });

  it('puts a none back to the model once, with the reason in the timeline', async () => {
    const seen: NextActionRequest[] = [];
    const twoTries: Provider = {
      id: 'openai',
      next: async (req) => {
        seen.push(req);
        return seen.length === 1 ? action({ kind: 'none', target: null, confidence: 0 }) : action();
      },
    };
    const diags: SuggestDiag[] = [];
    const res = await nextAction(snapshot(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => twoTries,
      onDiag: (d) => diags.push(d),
    });
    expect(res.action?.label).toBe('Click "Directions"');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.history.at(-1)).toBe(nudgeLine('none'));
    expect(diags.at(-1)?.reasked).toBe('none');
    expect(diags.at(-1)?.silent).toBeUndefined();
  });

  it('carries the validator’s own words into the re-ask', async () => {
    const seen: NextActionRequest[] = [];
    const offPage: Provider = {
      id: 'openai',
      next: async (req) => {
        seen.push(req);
        return seen.length === 1 ? action({ target: 99 }) : action();
      },
    };
    await nextAction(snapshot(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => offPage,
    });
    expect(seen[1]?.history.at(-1)).toBe(nudgeLine('no such control on the page'));
  });

  it('puts an ungrounded fill back to the model once, saying what was wrong with it', async () => {
    const seen: NextActionRequest[] = [];
    const invents: Provider = {
      id: 'openai',
      next: async (req) => {
        seen.push(req);
        return seen.length === 1 ? action({ kind: 'fill', target: 1, value: 'Quarry Lane Tavern', confidence: 0.9 }) : action();
      },
    };
    const diags: SuggestDiag[] = [];
    const res = await nextAction(snapshot(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => invents,
      onDiag: (d) => diags.push(d),
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.history.at(-1)).toBe(nudgeLine(UNGROUNDED));
    expect(diags.at(-1)?.reasked).toBe(UNGROUNDED);
    expect(res.action?.label).toBe('Click "Directions"');
  });

  it('reads on rather than type a tab’s name into the feed’s search box', async () => {
    const seen: NextActionRequest[] = [];
    const copies: Provider = {
      id: 'openai',
      next: async (req) => {
        seen.push(req);
        return action({ kind: 'fill', target: 1, value: 'Redirecting… | Slack', confidence: 0.86, label: 'Fill Search Reddit with "Redirecting… | Slack"' });
      },
    };
    const diags: SuggestDiag[] = [];
    const res = await nextAction(feedSnapshot(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => copies,
      notes: { lines: async () => [SLACK_NOTE] },
      tabs: async () => [SLACK_TAB],
      onDiag: (d) => diags.push(d),
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.history.at(-1)).toBe(nudgeLine(A_LABEL));
    expect(diags.at(-1)?.reasked).toBe(A_LABEL);
    // Nothing on the feed asks to be typed into, and there are three screens
    // below: the page's own plainest step is to read on.
    expect(res.action?.kind).toBe('scroll');
  });

  it('scrolls rather than say nothing when both tries come back empty', async () => {
    const diags: SuggestDiag[] = [];
    const res = await nextAction(scrollable(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => nothing,
      onDiag: (d) => diags.push(d),
    });
    expect(res.action?.kind).toBe('scroll');
    expect(res.action?.label).toBe('Scroll more');
    expect(diags.at(-1)?.source).toBe('fallback');
    expect(diags.at(-1)?.silent).toBeUndefined();
  });

  it('presses the page’s own control when there is nothing below, and never a risky one', async () => {
    const res = await nextAction(snapshot({ focused: undefined }), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => nothing,
    });
    // [1] is a searchbox and [3] takes money; [2] is what is left.
    expect(res.action).toMatchObject({ kind: 'click', target: 2 });
  });

  it('says why in plain words when even the page has nothing to stand in with', async () => {
    const diags: SuggestDiag[] = [];
    const bare = snapshot({ outline: 'main:\n  text: thanks, that is all', controls: [], focused: undefined });
    const res = await nextAction(bare, { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => nothing,
      onDiag: (d) => diags.push(d),
    });
    expect(res.action).toBeNull();
    expect(diags.at(-1)?.silent).toBe('nothing was offered and the page had no plainer step to stand in');
  });

  it('leaves the quieter levels alone: one call, nothing offered, and a reason', async () => {
    const calls = vi.fn(async () => null);
    const diags: SuggestDiag[] = [];
    const res = await nextAction(scrollable(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings({ eagerness: 'balanced' }),
      localProvider: nothing,
      createProvider: () => ({ id: 'openai' as const, next: calls }),
      onDiag: (d) => diags.push(d),
    });
    expect(res.action).toBeNull();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(diags.at(-1)?.reasked).toBeUndefined();
    expect(diags.at(-1)?.silent).toBe('nothing reached this level’s floor');
  });

  it('pushes the stand-in through the ticket when the model answers nothing', async () => {
    const refine = new RefineQueue({ setTimer: () => undefined });
    const res = await nextAction(scrollable(), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => nothing,
      refine,
    });
    expect(res.action).toBeNull();
    expect(res.ticket).toBeDefined();
    expect(await refine.claim(res.ticket!, 1)).toMatchObject({ action: { kind: 'scroll' } });
  });

  it('names the gate in the silent field too, so the popup never has to guess', async () => {
    const diags: SuggestDiag[] = [];
    await nextAction(snapshot({ password: true }), { tabId: 1, origin: 'x' }, {
      settings: async () => settings(),
      localProvider: nothing,
      createProvider: () => nothing,
      onDiag: (d) => diags.push(d),
    });
    expect(diags.at(-1)?.silent).toBe('the page has a password field');
  });
});

describe('the last resort', () => {
  it('reads on when there is more page, whatever else is on it', () => {
    const more = request({ page: { ...request().page, scroll: { y: 1.2, pages: 4, more: true } } });
    expect(lastResort(more)).toMatchObject({ kind: 'scroll', target: null, confidence: LAST_RESORT_CONFIDENCE });
  });

  it('fills the focused field from the notes before it presses anything', () => {
    const notes = request({ notes: ['Dinner at Seven Shores Cafe on Friday at 6.'] });
    expect(lastResort(notes)).toMatchObject({ kind: 'fill', target: 1 });
  });

  it('prefers the focused control, and skips a disabled or risky one', () => {
    const controls: OutlineControl[] = [
      { n: 1, role: 'button', name: 'Back', state: 'disabled' },
      { n: 2, role: 'button', name: 'Pay $312.40', risky: true },
      { n: 3, role: 'link', name: 'Read the rest' },
      { n: 4, role: 'button', name: 'Continue' },
    ];
    expect(lastResort(request({ controls, focused: undefined }))).toMatchObject({ kind: 'click', target: 3 });
    expect(lastResort(request({ controls, focused: 4 }))).toMatchObject({ kind: 'click', target: 4 });
  });

  it('has nothing to offer on a page with nothing on it', () => {
    expect(lastResort(request({ controls: [], focused: undefined }))).toBeNull();
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
