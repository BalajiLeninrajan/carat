import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextAction } from '@carat/shared';
import { createChip } from '../src/chip';
import type { ScriptContext } from '../src/content';
import { startActions } from '../src/content/action-scheduler';
import { UNDO_TIMING, createUndoDesk, fillUndo, isUndoKey, undoHint } from '../src/content/undo';
import type { FrameHub } from '../src/frames';
import { describeEntry, suggestionClause } from '../src/history';
import { performInteractionUndoable } from '../src/interact';
import { safeSendMessage } from '../src/messaging';
import type { TabsApi } from '../src/background';
import { performNavigation, undoNavigation } from '../src/background';

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

function layAll(): void {
  for (const el of document.querySelectorAll('input,button,a,select,textarea')) {
    el.getBoundingClientRect = () => ({ top: 100, left: 20, bottom: 130, right: 220, width: 200, height: 30 }) as DOMRect;
  }
}

function answer(next: NextAction | null, nav: Record<string, unknown> = { ok: true }): void {
  sent.mockImplementation((async (type: string) => {
    if (type === 'nextAction') return { action: next };
    if (type === 'nextActionRefine') return {};
    if (type === 'navigate') return nav;
    if (type === 'undoNavigate') return { ok: true };
    return undefined;
  }) as unknown as typeof safeSendMessage);
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const firstAsk = () => tick(0);

const tab = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
};

/** The platform's undo chord, as the page would send it. Returns the event so a test can read `defaultPrevented`. */
function undoPress(init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(e);
  return e;
}

const undones = (): string[] =>
  sent.mock.calls
    .filter((c) => c[0] === 'history')
    .flatMap((c) => (c[1] as { entries: Array<{ kind: string; what?: string }> }).entries)
    .filter((e) => e.kind === 'undone')
    .map((e) => e.what ?? '');

/** Start a scheduler with the chip, take the offer, and let the accept finish. */
async function accept(next: NextAction, nav?: Record<string, unknown>): Promise<ReturnType<typeof createChip>> {
  answer(next, nav);
  const chip = createChip(document);
  startActions(fakeCtx(), chip, document, { hub: noFrames });
  await firstAsk();
  tab();
  await tick(0);
  return chip;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent.mockReset();
  document.body.innerHTML = '';
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
});
afterEach(() => {
  for (const ctx of live.splice(0)) ctx.invalidate();
  vi.useRealTimers();
});

describe('the undo chord', () => {
  it('is Ctrl+Z off a Mac and Cmd+Z on one, and never the redo next to it', () => {
    const pc = { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' };
    const mac = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
    const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'z', ...init });

    expect(isUndoKey(press({ ctrlKey: true }), pc)).toBe(true);
    expect(isUndoKey(press({ metaKey: true }), pc)).toBe(false);
    expect(isUndoKey(press({ metaKey: true }), mac)).toBe(true);
    expect(isUndoKey(press({ ctrlKey: true }), mac)).toBe(false);
    expect(isUndoKey(press({ ctrlKey: true, shiftKey: true }), pc)).toBe(false);
    expect(isUndoKey(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }), pc)).toBe(false);
    expect(undoHint(mac)).toBe('⌘Z to undo');
    expect(undoHint(pc)).toBe('Ctrl+Z to undo');
  });

  it('runs the thunk once and then has nothing left to run', async () => {
    const run = vi.fn(async () => undefined);
    const onUndone = vi.fn();
    const desk = createUndoDesk(fakeCtx(), document, { onUndone });
    desk.offer({ what: 'click "Save"', run });
    expect(desk.armed).toBe(true);

    expect(desk.handle(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))).toBe(true);
    await tick(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onUndone).toHaveBeenCalledWith('click "Save"');
    expect(desk.handle(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))).toBe(false);
  });

  it('expires: past the window the key is the page’s again', async () => {
    const run = vi.fn(async () => undefined);
    const desk = createUndoDesk(fakeCtx(), document, { onUndone: () => undefined });
    desk.offer({ what: 'click "Save"', run });
    await tick(UNDO_TIMING.windowMs + 1);
    expect(desk.armed).toBe(false);
    expect(desk.handle(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('putting a control back', () => {
  it('restores a field’s value and fires input and change', async () => {
    document.body.innerHTML = '<input aria-label="Search" value="pans">';
    const input = document.querySelector('input')!;
    const events: string[] = [];
    for (const type of ['input', 'change']) input.addEventListener(type, () => events.push(type));

    const undo = fillUndo(input)!;
    input.value = 'Seven Shores Cafe';
    await undo();

    expect(input.value).toBe('pans');
    expect(events).toEqual(['input', 'change']);
  });

  it('restores the option a select had', async () => {
    document.body.innerHTML = '<select aria-label="Size"><option>S</option><option selected>M</option><option>L</option></select>';
    const select = document.querySelector('select')!;
    const changes = vi.fn();
    select.addEventListener('change', changes);

    const { ok, undo } = performInteractionUndoable(select, 'choose', 'L');
    expect([ok, select.value]).toEqual([true, 'L']);
    await undo!();

    expect(select.value).toBe('M');
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('restores a checkbox, and a switch, to the state it found them in', async () => {
    document.body.innerHTML = '<input type="checkbox" aria-label="Gift wrap"><div role="switch" aria-checked="false">Alerts</div>';
    const box = document.querySelector('input')!;
    const toggle = document.querySelector('[role="switch"]') as HTMLElement;
    // A real switch flips its own attribute on a click; this one stands in for the page's script.
    toggle.addEventListener('click', () => toggle.setAttribute('aria-checked', toggle.getAttribute('aria-checked') === 'true' ? 'false' : 'true'));

    const boxDone = performInteractionUndoable(box, 'click', '');
    expect(box.checked).toBe(true);
    await boxDone.undo!();
    expect(box.checked).toBe(false);

    const switchDone = performInteractionUndoable(toggle, 'click', '');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await switchDone.undo!();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('puts a radio group back on the option that was on', async () => {
    document.body.innerHTML =
      '<form><input type="radio" name="ship" value="slow" checked><input type="radio" name="ship" value="fast"></form>';
    const [slow, fast] = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];

    const { undo } = performInteractionUndoable(fast!, 'click', '');
    expect([slow!.checked, fast!.checked]).toEqual([false, true]);
    await undo!();
    expect([slow!.checked, fast!.checked]).toEqual([true, false]);
  });

  it('writes a radio off again when nothing in the group was on', async () => {
    document.body.innerHTML = '<form><input type="radio" name="ship" value="slow"><input type="radio" name="ship" value="fast"></form>';
    const [slow, fast] = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
    const changes = vi.fn();
    fast!.addEventListener('change', changes);

    const { undo } = performInteractionUndoable(fast!, 'click', '');
    await undo!();
    expect([slow!.checked, fast!.checked]).toEqual([false, false]);
    expect(changes).toHaveBeenCalled();
  });

  it('offers nothing for a plain button, which has no opposite', () => {
    document.body.innerHTML = '<button>Save</button>';
    const { ok, undo } = performInteractionUndoable(document.querySelector('button')!, 'click', '');
    expect([ok, undo]).toEqual([true, undefined]);
  });
});

describe('Ctrl+Z after a Tab', () => {
  it('takes back a fill, with the hint on screen while it can', async () => {
    document.body.innerHTML = '<main><input aria-label="Search" value="pans"><button>Go</button></main>';
    layAll();
    const input = document.querySelector('input')!;
    const chip = await accept(action({ kind: 'fill', target: 1, value: 'Seven Shores Cafe', label: 'Fill Search with "Seven Shores Cafe"' }));

    expect(input.value).toBe('Seven Shores Cafe');
    expect(chip.detail).toBe('Ctrl+Z to undo');

    const e = undoPress();
    await tick(0);
    expect(e.defaultPrevented).toBe(true);
    expect(input.value).toBe('pans');
    chip.destroy();
  });

  it('records what it undid and asks again once the page has settled', async () => {
    document.body.innerHTML = '<main><input type="checkbox" aria-label="Gift wrap"><button>Go</button></main>';
    layAll();
    const box = document.querySelector('input')!;
    const chip = await accept(action({ kind: 'click', target: 1, label: 'Click "Gift wrap"' }));
    expect(box.checked).toBe(true);
    const before = sent.mock.calls.filter((c) => c[0] === 'nextAction').length;

    undoPress();
    await tick(2000);

    expect(box.checked).toBe(false);
    expect(undones()).toEqual(['click "Gift wrap"']);
    expect(sent.mock.calls.filter((c) => c[0] === 'nextAction').length).toBeGreaterThan(before);
    chip.destroy();
  });

  it('scrolls back to where the page was', async () => {
    document.body.innerHTML = `<main><p>${'word '.repeat(400)}</p><button>Go</button></main>`;
    layAll();
    Object.defineProperty(window, 'scrollY', { value: 1200, configurable: true });
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    const chip = await accept(action({ kind: 'scroll', target: null, label: 'Scroll down' }));
    await tick(1500);

    undoPress();
    await tick(0);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 1200, left: 0, behavior: 'auto' });
    chip.destroy();
  });

  it('closes the tab it opened, and says which one', async () => {
    document.body.innerHTML = '<main><button>Go</button></main>';
    layAll();
    const chip = await accept(action({ kind: 'open', target: null, value: 'maps:Seven Shores Cafe', label: 'Open "Seven Shores Cafe" in Maps' }), {
      ok: true,
      tabId: 7,
      url: 'https://www.google.com/maps/search/Seven+Shores+Cafe',
    });

    undoPress();
    await tick(0);
    const call = sent.mock.calls.find((c) => c[0] === 'undoNavigate');
    expect(call?.[1]).toEqual({ kind: 'open', tabId: 7, url: 'https://www.google.com/maps/search/Seven+Shores+Cafe' });
    chip.destroy();
  });

  it('switches back to the tab the chip was on', async () => {
    document.body.innerHTML = '<main><button>Go</button></main>';
    layAll();
    const chip = await accept(action({ kind: 'switch', target: null, value: '12', label: 'Switch to Maps' }));

    undoPress();
    await tick(0);
    expect(sent.mock.calls.find((c) => c[0] === 'undoNavigate')?.[1]).toEqual({ kind: 'switch' });
    chip.destroy();
  });

  it('leaves the key to the page when the user is typing in a field of their own', async () => {
    document.body.innerHTML = '<main><input type="checkbox" aria-label="Gift wrap"><textarea aria-label="Note"></textarea></main>';
    layAll();
    const box = document.querySelector('input')!;
    const chip = await accept(action({ kind: 'click', target: 1, label: 'Click "Gift wrap"' }));
    expect(box.checked).toBe(true);

    document.querySelector('textarea')!.focus();
    const e = undoPress();
    await tick(0);

    expect(e.defaultPrevented).toBe(false);
    expect(box.checked).toBe(true);
    expect(undones()).toEqual([]);
    chip.destroy();
  });

  it('is over after the window, and the hint goes with it', async () => {
    document.body.innerHTML = '<main><input type="checkbox" aria-label="Gift wrap"><button>Go</button></main>';
    layAll();
    const box = document.querySelector('input')!;
    const chip = await accept(action({ kind: 'click', target: 1, label: 'Click "Gift wrap"' }));
    expect(chip.detail).toBe('Ctrl+Z to undo');

    await tick(UNDO_TIMING.windowMs + 100);
    expect(chip.detail).toBe('');
    undoPress();
    await tick(0);
    expect(box.checked).toBe(true);
    chip.destroy();
  });

  it('offers nothing for a plain click, and nothing for an irreversible one', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    const plain = await accept(action({ target: 1, label: 'Click "Save"' }));
    expect(plain.detail).toBe('');
    plain.destroy();

    document.body.innerHTML = '<main><input type="checkbox" aria-label="Delete everything"></main>';
    layAll();
    const box = document.querySelector('input')!;
    answer(action({ target: 1, label: 'Click "Delete everything"', irreversible: true }));
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await firstAsk();
    // The first Tab only arms it; the second is the one that acts.
    tab();
    expect(chip.armed).toBe(true);
    tab();
    await tick(0);

    expect(box.checked).toBe(true);
    expect(chip.detail).toBe('');
    undoPress();
    await tick(0);
    expect(box.checked).toBe(true);
    chip.destroy();
  });
});

describe('the tab carat opened', () => {
  function tabsFor(get: { id?: number; url?: string; windowId?: number } | undefined, created: { id?: number } = { id: 7 }) {
    const calls = {
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      focusWindow: vi.fn(async () => undefined),
      create: vi.fn(async (_props: { url: string; openerTabId?: number }) => created),
      get: vi.fn(async () => get),
    };
    return { api: calls as unknown as TabsApi, calls };
  }

  it('comes back with its id and the URL it was opened at', async () => {
    const { api, calls } = tabsFor(undefined);
    const res = await performNavigation({ kind: 'open', value: 'maps:Seven Shores Cafe' }, { tab: { id: 1 } }, api);
    expect(res.ok).toBe(true);
    expect(res.tabId).toBe(7);
    expect(res.url).toBe(calls.create.mock.calls[0]![0].url);
  });

  it('is closed, and the origin tab brought back, while it is still on that URL', async () => {
    const url = 'https://www.google.com/maps/search/Seven+Shores+Cafe';
    const { api, calls } = tabsFor({ id: 7, url, windowId: 3 });
    const res = await undoNavigation({ kind: 'open', tabId: 7, url }, { tab: { id: 1, windowId: 2 } }, api);

    expect(res.ok).toBe(true);
    expect(calls.remove).toHaveBeenCalledWith(7);
    expect(calls.update).toHaveBeenCalledWith(1, { active: true });
    expect(calls.focusWindow).toHaveBeenCalledWith(2);
  });

  it('is left alone once the user has navigated it', async () => {
    const { api, calls } = tabsFor({ id: 7, url: 'https://www.google.com/maps/place/Somewhere+Else' });
    const res = await undoNavigation(
      { kind: 'open', tabId: 7, url: 'https://www.google.com/maps/search/Seven+Shores+Cafe' },
      { tab: { id: 1, windowId: 2 } },
      api,
    );

    expect(res.ok).toBe(false);
    expect(calls.remove).not.toHaveBeenCalled();
    expect(calls.update).not.toHaveBeenCalled();
  });

  it('is left alone when it is gone, or when it is the tab that asked', async () => {
    const url = 'https://www.google.com/maps/search/Seven+Shores+Cafe';
    const gone = tabsFor(undefined);
    expect((await undoNavigation({ kind: 'open', tabId: 7, url }, { tab: { id: 1 } }, gone.api)).ok).toBe(false);
    expect(gone.calls.remove).not.toHaveBeenCalled();

    const self = tabsFor({ id: 1, url });
    expect((await undoNavigation({ kind: 'open', tabId: 1, url }, { tab: { id: 1 } }, self.api)).ok).toBe(false);
    expect(self.calls.remove).not.toHaveBeenCalled();
  });

  it('a switch only brings the origin tab forward', async () => {
    const { api, calls } = tabsFor({ id: 1, windowId: 2 });
    const res = await undoNavigation({ kind: 'switch' }, { tab: { id: 1, windowId: 2 } }, api);

    expect(res.ok).toBe(true);
    expect(calls.remove).not.toHaveBeenCalled();
    expect(calls.update).toHaveBeenCalledWith(1, { active: true });
  });
});

describe('the timeline line', () => {
  it('reads as an undo of the clause the accept used', () => {
    expect(suggestionClause('fill', 'Search')).toBe('fill "Search"');
    expect(describeEntry({ t: 0, kind: 'undone', what: suggestionClause('fill', 'Search') })).toBe('undid: fill "Search"');
    expect(describeEntry({ t: 0, kind: 'undone', what: suggestionClause('open', 'maps:Seven Shores Cafe') })).toBe(
      'undid: open "maps:Seven Shores Cafe"',
    );
  });
});
