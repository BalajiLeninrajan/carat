import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextAction, PageScroll } from '@carat/shared';
import { scrollLabel } from '@carat/shared';
import { AUTO_DISMISS_MS, CHIP_SETTLE_MS, QUIET_HINT, createChip } from '../src/chip';
import type { ScriptContext } from '../src/content';
import { SNAPSHOT_TIMING, startActions } from '../src/content/action-scheduler';
import type { FrameHub } from '../src/frames';
import { safeSendMessage } from '../src/messaging';
import { SCROLL_MAX_MS, SCROLL_SETTLE_MS, caratScrolling, scrollPageDown } from '../src/scroll';

vi.mock('../src/messaging', () => ({ safeSendMessage: vi.fn(async () => undefined) }));

const sent = vi.mocked(safeSendMessage);

/** Contexts handed out this test, so afterEach can stop every scheduler it started. */
const live: Array<{ invalidate(): void }> = [];

function fakeCtx(): ScriptContext {
  const listeners: Array<[EventTarget, string, EventListener, unknown]> = [];
  const onInvalid: Array<() => void> = [];
  const ctx = {
    isValid: true,
    setTimeout: (fn: () => void, ms?: number) => window.setTimeout(fn, ms),
    addEventListener(target: EventTarget, type: string, handler: EventListener, options?: unknown) {
      listeners.push([target, type, handler, options]);
      target.addEventListener(type, handler, options as AddEventListenerOptions);
    },
    onInvalidated(cb: () => void) {
      onInvalid.push(cb);
      return () => undefined;
    },
    invalidate() {
      ctx.isValid = false;
      for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options as AddEventListenerOptions);
      onInvalid.forEach((cb) => cb());
    },
  };
  live.push(ctx);
  return ctx as unknown as ScriptContext;
}

const noFrames: FrameHub = {
  frames: () => [],
  outlines: () => [],
  refresh: async () => undefined,
  perform: async () => ({ ok: false }),
  arm: () => undefined,
  disarm: () => undefined,
  anchor: () => null,
  numberOf: () => 1,
  destroy: () => undefined,
};

const action = (over: Partial<NextAction> = {}): NextAction => ({
  kind: 'click',
  target: 1,
  value: '',
  label: 'Click "Save"',
  irreversible: false,
  confidence: 0.8,
  reason: '',
  ...over,
});

/** Every element in the page sits in the viewport unless a test says otherwise. */
function layAll(): void {
  for (const el of document.querySelectorAll('input,button,a,select')) {
    el.getBoundingClientRect = () => ({ top: 100, left: 20, bottom: 130, right: 220, width: 200, height: 30 }) as DOMRect;
  }
}

function answer(action: NextAction | null, ticket?: string): void {
  sent.mockImplementation((async (type: string) => {
    if (type === 'nextAction') return { action, ...(ticket ? { ticket } : {}) };
    if (type === 'nextActionRefine') return {};
    if (type === 'navigate') return { ok: true };
    return undefined;
  }) as unknown as typeof safeSendMessage);
}

/** Answer each `nextAction` with the next action in the list; the last one stands. */
function answerEach(actions: Array<NextAction | null>): void {
  let i = 0;
  sent.mockImplementation((async (type: string) => {
    if (type === 'nextAction') return { action: actions[Math.min(i++, actions.length - 1)] ?? null };
    if (type === 'nextActionRefine') return {};
    if (type === 'navigate') return { ok: true };
    return undefined;
  }) as unknown as typeof safeSendMessage);
}

const asks = (): unknown[] => sent.mock.calls.filter((c) => c[0] === 'nextAction').map((c) => c[1]);
const feedbacks = (): Array<{ accepted: boolean; kind: string }> =>
  sent.mock.calls.filter((c) => c[0] === 'feedback').map((c) => c[1] as { accepted: boolean; kind: string });

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
/** The first ask goes out on the DOMContentLoaded tick; jsdom is already past it. */
const firstAsk = () => tick(0);
/** Long enough for the settle timer and the gap in front of it. */
const settled = () => tick(SNAPSHOT_TIMING.settleMs + SNAPSHOT_TIMING.minGapMs);
/** The fast lane: the frame after carat acted, plus the guard behind it. Well short of a settle. */
const performed = () => tick(SNAPSHOT_TIMING.afterPerformMs + 40);

const tab = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
};

beforeEach(() => {
  vi.useFakeTimers();
  sent.mockReset();
  document.body.innerHTML = '';
});
afterEach(() => {
  for (const ctx of live.splice(0)) ctx.invalidate();
  vi.useRealTimers();
});

describe('the one-chip scheduler', () => {
  it('reads the page, asks once, and puts the chip on the control the action names', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answer(action({ kind: 'fill', target: 1, value: 'Dinner', label: 'Fill Title with "Dinner"' }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();

    expect(asks()).toHaveLength(1);
    const request = asks()[0] as { controls: Array<{ name: string }>; outline: string };
    expect(request.controls.map((c) => c.name)).toEqual(['Title', 'Save']);
    expect(chip.visible).toBe(true);
    expect(chip.text).toBe('Fill Title with "Dinner"');
    chip.destroy();
  });

  it('shows a scroll as the bottom banner and performs it with no control at all', async () => {
    document.body.innerHTML = '<main><p>a long article</p><button>Save</button></main>';
    layAll();
    answer(action({ kind: 'scroll', target: null, label: 'Scroll down' }));
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.text).toBe('Scroll down');
    const host = document.querySelector('[data-carat-chip]') as HTMLElement;
    expect(host.style.left).toBe('50%');

    tab();
    await tick(1500);
    expect(scrollBy).toHaveBeenCalled();
    chip.destroy();
  });

  it('sends an open through the background, which rebuilds the URL', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answer(action({ kind: 'open', target: null, value: 'maps:Seven Shores Cafe', label: 'Open "Seven Shores Cafe" in Maps' }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    tab();
    await tick(0);
    expect(sent.mock.calls.some((c) => c[0] === 'navigate' && (c[1] as { value: string }).value === 'maps:Seven Shores Cafe')).toBe(true);
    chip.destroy();
  });

  it('clicks the control and reports it, so the timeline knows', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    const clicks = vi.fn();
    document.querySelector('button')!.addEventListener('click', clicks);
    answer(action({ target: 1, label: 'Click "Save"' }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect([chip.visible, chip.text]).toEqual([true, 'Click "Save"']);
    tab();
    await tick(0);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(feedbacks()[0]).toMatchObject({ accepted: true, kind: 'click' });
    chip.destroy();
  });

  it('shows nothing at all when the background has nothing', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.visible).toBe(false);
    chip.destroy();
  });
});

describe('when it asks', () => {
  it('asks at DOMContentLoaded, against a smaller outline than the ones after it', async () => {
    document.body.innerHTML = `<main><input aria-label="Title"><p>${'word '.repeat(3000)}</p><button>Save</button></main>`;
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);
    const first = (asks()[0] as { outline: string }).outline;
    expect(first.length).toBeLessThanOrEqual(SNAPSHOT_TIMING.firstBudget);

    // The page changes, settles, and the second look is the full one.
    const extra = document.createElement('p');
    extra.textContent = 'and one more paragraph';
    document.querySelector('main')!.append(extra);
    await settled();
    expect(asks()).toHaveLength(2);
    expect((asks()[1] as { outline: string }).outline.length).toBeGreaterThan(first.length);
    chip.destroy();
  });

  it('does not ask again when the page settles with the same outline', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);

    // A mutation that leaves the outline as it was: a class change, nothing to read.
    document.querySelector('button')!.classList.add('hot');
    await settled();
    expect(asks()).toHaveLength(1);
    chip.destroy();
  });

  it('asks again when the page hands it new text, though the outline has not moved', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    const handle = startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);

    handle.refresh();
    await settled();
    expect(asks()).toHaveLength(2);
    chip.destroy();
  });

  it('asks again as soon as the focus moves', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><input aria-label="Notes"></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);

    // Past the gap, so the focus ask is not merely waiting its turn.
    await tick(SNAPSHOT_TIMING.minGapMs);
    document.querySelector<HTMLInputElement>('[aria-label="Notes"]')!.focus();
    await tick(0);
    expect(asks()).toHaveLength(2);
    chip.destroy();
  });

  it('asks again once a scroll of the user’s own settles, against the page the scroll uncovered', async () => {
    // The outline stops at the fold, so the second screen is not in the first question.
    const vh = window.innerHeight;
    document.body.innerHTML = '<main><button>Save</button><a href="https://example.com/more">Read more</a></main>';
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: vh * 2, configurable: true });
    let scrolled = 0;
    const place = (el: Element, top: number): void => {
      el.getBoundingClientRect = () => new DOMRect(0, top - scrolled, 300, 40);
    };
    place(document.querySelector('button')!, 10);
    place(document.querySelector('a')!, vh * 1.5);
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);
    const first = (asks()[0] as { outline: string }).outline;
    expect(first).not.toContain('Read more');

    scrolled = vh;
    Object.defineProperty(window, 'scrollY', { value: vh, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    await settled();
    expect(asks()).toHaveLength(2);
    // The hash moved with the visible set, so this is a new question, not the memo's.
    const second = (asks()[1] as { outline: string }).outline;
    expect(second).toContain('Read more');
    expect(second).not.toBe(first);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    chip.destroy();
  });

  it('coalesces a burst of interactions into one request', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);

    const input = document.querySelector<HTMLInputElement>('input')!;
    for (let i = 0; i < 12; i++) {
      input.value = `Din${'n'.repeat(i)}er`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await tick(30);
    }
    await settled();
    expect(asks()).toHaveLength(2);
    chip.destroy();
  });
});

describe('keeping going', () => {
  it('offers the next field once the first is filled, and then the button', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><input aria-label="Notes"><button>Save</button></main>';
    layAll();
    answerEach([
      action({ kind: 'fill', target: 1, value: 'Dinner', label: 'Fill Title with "Dinner"' }),
      action({ kind: 'fill', target: 2, value: 'Seven Shores', label: 'Fill Notes with "Seven Shores"' }),
      action({ kind: 'click', target: 3, label: 'Click "Save"' }),
    ]);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.text).toBe('Fill Title with "Dinner"');

    tab();
    await performed();
    // Nobody asked for this one: accepting the fill is what brought it.
    expect(chip.visible).toBe(true);
    expect(chip.text).toBe('Fill Notes with "Seven Shores"');
    // The accept is in the timeline before the question that follows it.
    const order = sent.mock.calls.map((c) => c[0]);
    expect(order.indexOf('feedback')).toBeLessThan(order.lastIndexOf('nextAction'));

    tab();
    await performed();
    expect(chip.text).toBe('Click "Save"');
    chip.destroy();
  });

  it('never offers the same action twice on one page load', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    const fill = action({ kind: 'fill', target: 1, value: 'Dinner', label: 'Fill Title with "Dinner"' });
    answer(fill);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.visible).toBe(true);

    tab();
    await performed();
    // The background offered the same fill again; it is already done here.
    expect(asks().length).toBeGreaterThan(1);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });

  it('says nothing more after Esc until the retry comes due, or the user moves first', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answerEach([action({ target: 2, label: 'Click "Save"' }), action({ kind: 'fill', target: 1, value: 'Dinner', label: 'Fill Title with "Dinner"' })]);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(chip.visible).toBe(false);
    expect(feedbacks()[0]!.accepted).toBe(false);

    // The page keeps changing under it; none of that is the user.
    const grown = document.createElement('p');
    grown.textContent = 'the page rewrote itself';
    document.querySelector('main')!.append(grown);
    await settled();
    expect(asks()).toHaveLength(1);

    // They click before the retry timer is up, so that is the question that goes.
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settled();
    expect(asks()).toHaveLength(2);
    expect(chip.text).toBe('Fill Title with "Dinner"');
    // The retry the Esc queued was called off by the click, not merely delayed.
    await tick(SNAPSHOT_TIMING.escRetryMs[0]);
    expect(asks()).toHaveLength(2);
    chip.destroy();
  });

  it('holds a request that would land inside the gap', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);

    document.querySelector<HTMLInputElement>('input')!.focus();
    await tick(0);
    // The focus asked at once, but the gap since the first request is not up.
    expect(asks()).toHaveLength(1);
    await tick(SNAPSHOT_TIMING.minGapMs);
    expect(asks()).toHaveLength(2);
    chip.destroy();
  });
});

describe('the fast lane after carat acts', () => {
  it('asks inside a frame and a guard of the fill, with the chip up long before the settle', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><input aria-label="Notes"><button>Save</button></main>';
    layAll();
    answerEach([
      action({ kind: 'fill', target: 1, value: 'Dinner', label: 'Fill Title with "Dinner"' }),
      action({ kind: 'fill', target: 2, value: 'Seven Shores', label: 'Fill Notes with "Seven Shores"' }),
    ]);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();

    tab();
    // The fill is in and reported, but the frame it lands in has not come round yet.
    await tick(0);
    expect(asks()).toHaveLength(1);

    await performed();
    expect(asks()).toHaveLength(2);
    expect(chip.text).toBe('Fill Notes with "Seven Shores"');
    // Under a fifth of what the old settle cost, and the gap is no part of it either.
    expect(SNAPSHOT_TIMING.afterPerformMs + 40).toBeLessThan(SNAPSHOT_TIMING.settleMs);
    chip.destroy();
  });

  it('asks once more, and only once, when the page goes on loading behind the immediate question', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    // The click lands on a page that has nothing to offer yet; the form arrives after it.
    answerEach([action({ kind: 'fill', target: 1, value: 'Dinner', label: 'Fill Title with "Dinner"' }), null, action({ target: 2, label: 'Click "Save"' })]);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();

    tab();
    await performed();
    expect(asks()).toHaveLength(2);
    expect(chip.visible).toBe(false);
    const immediate = (asks()[1] as { outline: string }).outline;

    // The rest of the page arrives. The settle watcher is still behind the immediate ask.
    const late = document.createElement('p');
    late.textContent = 'the rest of the page arrived';
    document.querySelector('main')!.append(late);
    await settled();
    expect(asks()).toHaveLength(3);
    expect((asks()[2] as { outline: string }).outline).not.toBe(immediate);
    expect(chip.text).toBe('Click "Save"');

    // Both watchers wanted that question; only one went out, and nothing follows it.
    await tick(SNAPSHOT_TIMING.settleMs * 4);
    expect(asks()).toHaveLength(3);
    chip.destroy();
  });

  it('holds the settle re-ask when the outline did not move', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answerEach([
      action({ kind: 'fill', target: 1, value: 'Dinner', label: 'Fill Title with "Dinner"' }),
      action({ target: 2, label: 'Click "Save"' }),
    ]);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();

    tab();
    await performed();
    expect(asks()).toHaveLength(2);

    // Nothing changed after the immediate question, so there is nothing to ask again about.
    await tick(SNAPSHOT_TIMING.settleMs * 4);
    expect(asks()).toHaveLength(2);
    chip.destroy();
  });

  it('leaves the user\u2019s own click waiting out the settle', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    // Past the gap, so the settle is the only thing left in the way.
    await tick(SNAPSHOT_TIMING.minGapMs);

    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(SNAPSHOT_TIMING.settleMs - 1);
    expect(asks()).toHaveLength(1);
    await tick(1);
    expect(asks()).toHaveLength(2);
    chip.destroy();
  });
});

describe('Esc means "not that"', () => {
  const esc = (): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  };
  const [FIRST_WAIT, SECOND_WAIT, LAST_WAIT] = SNAPSHOT_TIMING.escRetryMs;

  it('asks again after the first wait, with the dismissal already reported', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answerEach([action({ target: 2, label: 'Click "Save"' }), action({ kind: 'fill', target: 1, value: 'Dinner', label: 'Fill Title with "Dinner"' })]);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    esc();
    expect(chip.visible).toBe(false);

    await tick(FIRST_WAIT - 1);
    expect(asks()).toHaveLength(1);
    await tick(1);
    expect(asks()).toHaveLength(2);
    // The dismissal reaches the background before the question that has to read it.
    const order = sent.mock.calls.map((c) => c[0]);
    expect(order.indexOf('feedback')).toBeLessThan(order.lastIndexOf('nextAction'));
    expect(feedbacks()[0]).toMatchObject({ accepted: false, kind: 'click' });
    // And the model picked something else, which is what the chip now offers.
    expect(chip.text).toBe('Fill Title with "Dinner"');
    chip.destroy();
  });

  it('backs off to the second wait, then keeps asking at the last wait', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><input aria-label="Notes"><input aria-label="Where"><button>Save</button></main>';
    layAll();
    answerEach([
      action({ target: 4, label: 'Click "Save"' }),
      action({ kind: 'fill', target: 1, value: 'Dinner', label: 'Fill Title with "Dinner"' }),
      action({ kind: 'fill', target: 2, value: 'Seven Shores', label: 'Fill Notes with "Seven Shores"' }),
      action({ kind: 'fill', target: 3, value: 'Waterloo', label: 'Fill Where with "Waterloo"' }),
    ]);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();

    esc();
    await tick(FIRST_WAIT);
    expect(asks()).toHaveLength(2);

    // The second refusal buys a longer wait, not the same one.
    esc();
    await tick(FIRST_WAIT);
    expect(asks()).toHaveLength(2);
    await tick(SECOND_WAIT - FIRST_WAIT);
    expect(asks()).toHaveLength(3);

    // The third buys the last wait, and so does every refusal after it: carat never goes quiet on its own.
    esc();
    await tick(LAST_WAIT - 1);
    expect(asks()).toHaveLength(3);
    await tick(1);
    expect(asks()).toHaveLength(4);
    esc();
    await tick(LAST_WAIT);
    expect(asks()).toHaveLength(5);
    chip.destroy();
  });

  it('never offers an action it was refused, however often it asks', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answer(action({ target: 2, label: 'Click "Save"' }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.text).toBe('Click "Save"');

    esc();
    await tick(FIRST_WAIT);
    // It asked again and the background offered the same thing; the chip stays down.
    expect(asks()).toHaveLength(2);
    expect(chip.visible).toBe(false);

    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settled();
    expect(asks().length).toBeGreaterThan(2);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });
});

describe('Shift+Tab: quiet for a minute', () => {
  const esc = (): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  };
  const shiftTab = (): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e;
  };
  const LAST_WAIT = SNAPSHOT_TIMING.escRetryMs[SNAPSHOT_TIMING.escRetryMs.length - 1]!;
  const histories = (): string[] =>
    sent.mock.calls
      .filter((c) => c[0] === 'history')
      .flatMap((c) => (c[1] as { entries: Array<{ kind: string }> }).entries.map((e) => e.kind));

  /** A page of fields, and one fill for each, so every retry has something new to offer. */
  function fields(n: number): { chip: ReturnType<typeof createChip>; handle: ReturnType<typeof startActions> } {
    document.body.innerHTML = `<main>${Array.from({ length: n }, (_, i) => `<input aria-label="F${i + 1}">`).join('')}</main>`;
    layAll();
    answerEach(
      Array.from({ length: n }, (_, i) =>
        action({ kind: 'fill', target: i + 1, value: `v${i + 1}`, label: `Fill F${i + 1} with "v${i + 1}"` }),
      ),
    );
    const chip = createChip(document);
    const handle = startActions(fakeCtx(), chip, document, { hub: noFrames });
    return { chip, handle };
  }

  /** Refuse the chip that is up, and wait for the one the retry brings. */
  async function refuse(): Promise<void> {
    esc();
    await tick(LAST_WAIT);
  }

  it('offers the key on the chip once Esc has come five times, and not before', async () => {
    const { chip } = fields(SNAPSHOT_TIMING.snoozeAfterEscapes + 1);
    await firstAsk();

    for (let i = 1; i < SNAPSHOT_TIMING.snoozeAfterEscapes; i++) await refuse();
    // The fifth chip: four refusals behind it, and no advice yet.
    expect(chip.visible).toBe(true);
    expect(chip.detail).toBe('');

    await refuse();
    expect(chip.visible).toBe(true);
    expect(chip.detail).toBe(QUIET_HINT);
    chip.destroy();
  });

  it('takes the chip down and lets nothing out for the minute', async () => {
    const { chip } = fields(3);
    await firstAsk();
    // A refusal first, so the retry chain is live when the snooze lands on it.
    esc();
    await tick(LAST_WAIT);
    expect(asks()).toHaveLength(2);

    const e = shiftTab();
    expect(e.defaultPrevented).toBe(true);
    expect(chip.visible).toBe(false);
    // Nothing was refused here, so nothing is reported against the offer that was up.
    expect(feedbacks()).toHaveLength(1);
    expect(histories()).toEqual(['snoozed']);

    // The user carries on with the page and it carries on rewriting itself; carat says nothing.
    document.querySelector<HTMLInputElement>('[aria-label="F2"]')!.focus();
    document.querySelector('main')!.append(document.createElement('p'));
    document.querySelector('[aria-label="F1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(SNAPSHOT_TIMING.snoozeMs - 1);
    expect(asks()).toHaveLength(2);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });

  it('leaves Shift+Tab to the page when there is no chip to silence', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.visible).toBe(false);
    expect(shiftTab().defaultPrevented).toBe(false);
    expect(asks()).toHaveLength(1);
    chip.destroy();
  });

  it('disarms an irreversible chip rather than acting on it', async () => {
    document.body.innerHTML = '<main><button>Send</button></main>';
    layAll();
    answer(action({ target: 1, label: 'Click "Send"', irreversible: true }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    tab();
    expect(chip.armed).toBe(true);

    shiftTab();
    expect(chip.armed).toBe(false);
    expect(chip.visible).toBe(false);
    expect(feedbacks()).toHaveLength(0);
    expect(histories()).toEqual(['snoozed']);
    chip.destroy();
  });

  it('ends the snooze on the shortcut and asks at once', async () => {
    const { chip, handle } = fields(3);
    await firstAsk();
    shiftTab();
    await tick(SNAPSHOT_TIMING.minGapMs);
    expect(asks()).toHaveLength(1);

    handle.force();
    await tick(0);
    expect(asks()).toHaveLength(2);
    chip.destroy();
  });

  it('starts the refusals over when the minute is up, and waits for a trigger to ask', async () => {
    const { chip } = fields(SNAPSHOT_TIMING.snoozeAfterEscapes + 1);
    await firstAsk();
    for (let i = 0; i < SNAPSHOT_TIMING.snoozeAfterEscapes; i++) await refuse();
    expect(chip.detail).toBe(QUIET_HINT);
    const before = asks().length;

    shiftTab();
    await tick(SNAPSHOT_TIMING.snoozeMs);
    // The clock running out is not a reason to ask; it only lifts the silence.
    expect(asks()).toHaveLength(before);
    expect(chip.visible).toBe(false);

    // The page moves, which is an ordinary trigger, and the counter it asks with has started over.
    document.querySelector('main')!.append(document.createElement('input'));
    layAll();
    await tick(SNAPSHOT_TIMING.mutationQuietMs + SNAPSHOT_TIMING.minGapMs);
    expect(asks()).toHaveLength(before + 1);
    expect(chip.visible).toBe(true);
    expect(chip.detail).toBe('');
    chip.destroy();
  });
});

describe('getting out of the way', () => {
  const upOnSave = async (chip: ReturnType<typeof createChip>): Promise<void> => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answer(action({ target: 2, label: 'Click "Save"' }));
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.visible).toBe(true);
    // Past the window that belongs to carat's own scrolling.
    await tick(CHIP_SETTLE_MS);
  };

  it('goes on a pointerdown off the chip, and says nothing about the offer', async () => {
    const chip = createChip(document);
    await upOnSave(chip);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(chip.visible).toBe(false);
    expect(feedbacks()).toHaveLength(0);
    chip.destroy();
  });

  it('goes on a key that is not Tab or Esc, but not on a bare modifier', async () => {
    const chip = createChip(document);
    await upOnSave(chip);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    expect(chip.visible).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(chip.visible).toBe(false);
    expect(feedbacks()).toHaveLength(0);
    chip.destroy();
  });

  it('goes on a wheel, a touchmove and a scroll', async () => {
    for (const type of ['wheel', 'touchmove', 'scroll']) {
      const chip = createChip(document);
      await upOnSave(chip);
      window.dispatchEvent(new Event(type));
      expect([type, chip.visible]).toEqual([type, false]);
      expect(feedbacks()).toHaveLength(0);
      chip.destroy();
    }
  });

  it('goes when the focus lands on another control', async () => {
    const chip = createChip(document);
    await upOnSave(chip);
    document.querySelector<HTMLInputElement>('input')!.focus();
    expect(chip.visible).toBe(false);
    expect(feedbacks()).toHaveLength(0);
    chip.destroy();
  });

  it('ignores the tail of the scroll carat itself did to place the chip', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answer(action({ target: 2, label: 'Click "Save"' }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.visible).toBe(true);
    // Inside the settle window the chip stays; past it the next one takes it away.
    window.dispatchEvent(new Event('scroll'));
    expect(chip.visible).toBe(true);
    await tick(CHIP_SETTLE_MS);
    window.dispatchEvent(new Event('scroll'));
    expect(chip.visible).toBe(false);
    chip.destroy();
  });

  it('takes a scroll of the user’s own as the scroll it offered, and does not offer it again', async () => {
    document.body.innerHTML = '<main><p>a long article</p><button>Save</button></main>';
    layAll();
    answer(action({ kind: 'scroll', target: null, label: 'Scroll down' }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.text).toBe('Scroll down');

    await tick(CHIP_SETTLE_MS);
    window.dispatchEvent(new Event('wheel'));
    expect(chip.visible).toBe(false);
    expect(feedbacks()).toHaveLength(0);

    // The user acting is a reason to ask again; the scroll is not offered a second time.
    await settled();
    expect(asks().length).toBeGreaterThan(1);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });
});

describe('scroll, then scroll again', () => {
  /**
   * A page three viewports tall that really moves: carat's scroll arrives
   * over several frames, as a smooth one does, and every frame is a scroll
   * event the page can hear.
   */
  function threeScreens(): void {
    const vh = window.innerHeight;
    document.body.innerHTML = '<main><p>screen one</p><p>screen two</p><p>screen three</p><button>Save</button></main>';
    let y = 0;
    Object.defineProperty(window, 'scrollY', { get: () => y, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: vh * 3, configurable: true });
    [...document.querySelectorAll('p')].forEach((el, i) => {
      el.getBoundingClientRect = () => new DOMRect(0, vh * i - y, 300, 40);
    });
    document.querySelector('button')!.getBoundingClientRect = () => new DOMRect(0, 100 - y, 100, 30);
    window.scrollBy = ((opts: ScrollToOptions) => {
      const from = y;
      const to = Math.min(y + (opts.top ?? 0), vh * 2);
      // Four frames, the last of them well past the settle window.
      for (let step = 1; step <= 4; step++) {
        window.setTimeout(() => {
          y = from + ((to - from) * step) / 4;
          window.dispatchEvent(new Event('scroll'));
        }, step * 40);
      }
    }) as typeof window.scrollBy;
  }

  /** The background as the engine answers it: a scroll only while there is page below, labelled from where the page is. */
  function answerScrolls(): void {
    sent.mockImplementation((async (type: string, msg: unknown) => {
      if (type === 'nextAction') {
        const { scroll } = (msg as { page: { scroll: PageScroll } }).page;
        if (!scroll.more) return { action: null };
        return { action: action({ kind: 'scroll', target: null, value: '', label: scrollLabel(scroll) }) };
      }
      if (type === 'nextActionRefine') return {};
      return undefined;
    }) as unknown as typeof safeSendMessage);
  }

  /** Carat's scroll runs, the mark comes off, and the question goes out on it. */
  const scrolledAndSettled = async (): Promise<void> => {
    await tick(SCROLL_MAX_MS + SCROLL_SETTLE_MS);
  };

  afterEach(() => {
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('offers the next scroll once the page has moved, and stops at the bottom', async () => {
    threeScreens();
    answerScrolls();
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.text).toBe('Scroll down');

    // One Tab, and nothing else: no click, no keystroke, no scroll of the user's own.
    tab();
    await scrolledAndSettled();
    expect(window.scrollY).toBe(window.innerHeight);
    expect(chip.visible).toBe(true);
    expect(chip.text).toBe('Scroll more');
    // The accept is in the timeline before the question that reads it.
    const order = sent.mock.calls.map((c) => c[0]);
    expect(order.indexOf('feedback')).toBeLessThan(order.lastIndexOf('nextAction'));
    expect(feedbacks()[0]).toMatchObject({ accepted: true, kind: 'scroll' });

    // The second Tab lands on the last screen, where there is nothing below to offer.
    tab();
    await scrolledAndSettled();
    expect(window.scrollY).toBe(window.innerHeight * 2);
    expect(asks().length).toBeGreaterThan(2);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });

  it('waits for carat\u2019s own scrolling to stop, and asks the moment it does', async () => {
    threeScreens();
    answerScrolls();
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);

    tab();
    // The page is still under carat's mark; the outline it would read now is the one already asked about.
    await tick(300);
    expect(caratScrolling()).toBe(true);
    expect(asks()).toHaveLength(1);

    // The mark comes off and the question goes out on it, well short of the settle.
    await tick(SCROLL_SETTLE_MS + 20);
    expect(caratScrolling()).toBe(false);
    expect(asks()).toHaveLength(2);
    expect(chip.text).toBe('Scroll more');
    chip.destroy();
  });

  it('keeps the chip up while carat is the one scrolling', async () => {
    threeScreens();
    answer(action({ target: 1, label: 'Click "Save"' }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.visible).toBe(true);
    // Past the window the chip grants its own arrival, so only the mark can save it.
    await tick(CHIP_SETTLE_MS);

    void scrollPageDown(window);
    await tick(200);
    expect(window.scrollY).toBeGreaterThan(0);
    expect(chip.visible).toBe(true);

    // Once carat's scroll has stopped, a scroll is the user reading on again.
    await tick(SCROLL_MAX_MS + SCROLL_SETTLE_MS);
    window.dispatchEvent(new Event('scroll'));
    expect(chip.visible).toBe(false);
    chip.destroy();
  });
});

describe('the early ring', () => {
  it('rings the control the model named before the words arrive', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    const words = action({ target: 2, label: 'Click "Save"' });
    let refines = 0;
    // The words are held back, so the ring has to stand on its own first.
    let sayIt: (update: unknown) => void = () => undefined;
    sent.mockImplementation((async (type: string) => {
      if (type === 'nextAction') return { action: null, ticket: 't1' };
      if (type === 'nextActionRefine') {
        if (refines++ === 0) return { target: 2, more: true };
        return new Promise((r) => (sayIt = r));
      }
      return undefined;
    }) as unknown as typeof safeSendMessage);

    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    // Only the number has landed: the ring is up and there is nothing to read yet.
    const ring = document.querySelector('[data-carat-ring]') as HTMLElement;
    expect(ring.style.display).toBe('block');
    expect(chip.text).toBe('');
    expect(chip.visible).toBe(false);

    sayIt({ action: words });
    await tick(0);
    expect(chip.text).toBe('Click "Save"');
    chip.destroy();
  });
});

describe('a ticket the service worker lost', () => {
  it('asks again rather than settling for the placeholder, and only once', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    const save = action({ target: 2, label: 'Click "Save"' });
    let asked = 0;
    sent.mockImplementation((async (type: string) => {
      // The first request gets a ticket the restarted worker knows nothing about.
      if (type === 'nextAction') return asked++ === 0 ? { action: null, ticket: 't1' } : { action: save };
      if (type === 'nextActionRefine') return { lost: true };
      return undefined;
    }) as unknown as typeof safeSendMessage);

    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);

    // Nothing waited for: the re-ask only sits out the gap in front of it.
    await tick(SNAPSHOT_TIMING.minGapMs);
    expect(asks()).toHaveLength(2);
    expect(chip.text).toBe('Click "Save"');

    // A worker that keeps dying costs one extra request, not a loop. Stop
    // short of the chip's own auto-dismiss, which is a question of its own.
    await tick(AUTO_DISMISS_MS - SNAPSHOT_TIMING.minGapMs);
    expect(asks()).toHaveLength(2);
    chip.destroy();
  });
});

describe('an exchange that put nothing on screen', () => {
  it('asks again past the memo, and gives up after a few tries', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);

    // The outline has not moved, so the memo would hold this back; nothing is
    // on screen, so the memo's stored answer was no answer.
    await tick(SNAPSHOT_TIMING.silentRetryMs + SNAPSHOT_TIMING.minGapMs);
    expect(asks()).toHaveLength(2);

    // Bounded: the page that truly has nothing is allowed to say so.
    await tick((SNAPSHOT_TIMING.silentRetryMs + SNAPSHOT_TIMING.minGapMs) * 6);
    expect(asks()).toHaveLength(1 + SNAPSHOT_TIMING.silentRetries);
    chip.destroy();
  });

  it('stops the moment a chip goes up', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answer(action({ target: 1, label: 'Click "Save"' }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.visible).toBe(true);
    await tick((SNAPSHOT_TIMING.silentRetryMs + SNAPSHOT_TIMING.minGapMs) * 3);
    expect(asks()).toHaveLength(1);
    chip.destroy();
  });

  it('says nothing more once the user has asked for quiet', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answerEach([action({ target: 1, label: 'Click "Save"' }), null]);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    const before = asks().length;
    await tick((SNAPSHOT_TIMING.silentRetryMs + SNAPSHOT_TIMING.minGapMs) * 4);
    expect(asks()).toHaveLength(before);
    chip.destroy();
  });

  it('asks again when the chip runs out of time on its own', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answer(action({ target: 1, label: 'Click "Save"' }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(chip.visible).toBe(true);
    expect(asks()).toHaveLength(1);

    // Twenty seconds of the user doing nothing takes the chip away. The page
    // still has a button on it, so the question goes back out.
    await tick(AUTO_DISMISS_MS);
    expect(chip.visible).toBe(false);
    await tick(SNAPSHOT_TIMING.silentRetryMs + SNAPSHOT_TIMING.minGapMs);
    expect(asks()).toHaveLength(2);
    expect(chip.visible).toBe(true);
    chip.destroy();
  });
});

describe('a context clear', () => {
  it('drops the chip, the memo and what this page load had answered', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    const save = action({ target: 2, label: 'Click "Save"' });
    answer(save);
    const chip = createChip(document);
    const handle = startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    tab();
    await performed();
    // Accepted once, so it will not be offered again.
    expect(chip.visible).toBe(false);

    handle.clear();
    expect(chip.visible).toBe(false);
    const before = asks().length;

    // Nothing on the spot, and nothing the memo would stand in the way of:
    // a page load that knows nothing is owed a chip again, so one question
    // goes out once the page has settled.
    expect(asks()).toHaveLength(before);
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settled();
    expect(asks().length).toBe(before + 1);
    // What was accepted was forgotten with everything else, so the same action is on offer again.
    expect(chip.text).toBe('Click "Save"');
    chip.destroy();
  });

  it('asks once on its own, so a wipe does not leave the page with no chip', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answer(action({ target: 1, label: 'Click "Save"' }));
    const chip = createChip(document);
    const handle = startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    const before = asks().length;

    handle.clear();
    expect(chip.visible).toBe(false);
    // Nobody touches the page after the wipe; the chip comes back anyway.
    await settled();
    expect(asks().length).toBe(before + 1);
    expect(chip.text).toBe('Click "Save"');
    chip.destroy();
  });

  it('drops a request that was already in flight', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    let release: (v: unknown) => void = () => undefined;
    sent.mockImplementation((async (type: string) => {
      if (type === 'nextAction') return new Promise((r) => (release = r));
      return undefined;
    }) as unknown as typeof safeSendMessage);
    const chip = createChip(document);
    const handle = startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    expect(asks()).toHaveLength(1);

    handle.clear();
    release({ action: action({ target: 1, label: 'Click "Save"' }) });
    await tick(0);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });
});
