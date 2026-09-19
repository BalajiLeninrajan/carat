import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_LIMITS, HISTORY_TIMING, describeEntry, renderHistory, startHistoryRecorder } from '../src/history';
import type { HistoryEntry } from '../src/history';
import { HistoryStore } from '../src/background/history';
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

function setup(start = 1_000_000) {
  let clock = start;
  const area = new FakeArea();
  const history = new HistoryStore(area, { now: () => clock });
  return { area, history, at: () => clock, tick: (ms: number) => (clock += ms) };
}

const MIN = 60_000;

describe('history entries', () => {
  it('says what happened, in the words the model reads', () => {
    expect(describeEntry({ t: 0, kind: 'click', role: 'button', name: 'Add to cart' })).toBe('clicked button "Add to cart"');
    expect(describeEntry({ t: 0, kind: 'type', name: 'Search', value: 'moms pan' })).toBe('typed into "Search" ("moms pan")');
    expect(describeEntry({ t: 0, kind: 'nav', how: 'link', to: 'shop.example/cart' })).toBe('followed a link to shop.example/cart');
    expect(describeEntry({ t: 0, kind: 'nav', how: 'back_forward', to: 'shop.example' })).toBe('went back to shop.example');
    expect(describeEntry({ t: 0, kind: 'opened', from: 3 })).toBe('opened from tab 3');
    expect(describeEntry({ t: 0, kind: 'accepted', what: 'click button "Save"' })).toBe('accepted suggestion: click button "Save"');
    expect(describeEntry({ t: 0, kind: 'dismissed', what: 'fill "Search"' })).toBe('dismissed suggestion: fill "Search"');
  });

  it('renders the last twelve, oldest first, with their ages', () => {
    const now = 1_000_000;
    const entries: HistoryEntry[] = Array.from({ length: 20 }, (_, i) => ({ t: now - (20 - i) * 1000, kind: 'click', role: 'button', name: `Button ${i}` }));
    const lines = renderHistory(entries, now);

    expect(lines).toHaveLength(HISTORY_LIMITS.maxLines);
    expect(lines[0]).toBe('12s ago: clicked button "Button 8"');
    expect(lines[lines.length - 1]).toBe('just now: clicked button "Button 19"');
  });

  it('leaves out anything past the half hour', () => {
    const now = 10 * 60 * MIN;
    const lines = renderHistory(
      [
        { t: now - 31 * MIN, kind: 'click', role: 'button', name: 'Ancient' },
        { t: now - 2 * MIN, kind: 'click', role: 'button', name: 'Recent' },
      ],
      now,
    );
    expect(lines).toEqual(['2m ago: clicked button "Recent"']);
  });
});

describe('HistoryStore', () => {
  it('keeps a timeline per tab and renders only that tab', async () => {
    const { history, at } = setup();
    await history.record(1, { t: at(), kind: 'click', role: 'button', name: 'Add to cart' });
    await history.record(2, { t: at(), kind: 'click', role: 'button', name: 'Somewhere else' });

    expect(await history.lines(1)).toEqual(['just now: clicked button "Add to cart"']);
    expect(await history.lines(2)).toEqual(['just now: clicked button "Somewhere else"']);
    expect(await history.lines(3)).toEqual([]);
  });

  it('caps a tab at thirty entries, the oldest going first', async () => {
    const { history, at, tick } = setup();
    for (let i = 0; i < 40; i++) {
      await history.record(1, { t: at(), kind: 'click', role: 'button', name: `Button ${i}` });
      tick(1000);
    }
    const entries = await history.entries(1);

    expect(entries).toHaveLength(HISTORY_LIMITS.maxEntries);
    expect(entries[0]!).toMatchObject({ name: 'Button 10' });
  });

  it('ages entries out after half an hour', async () => {
    const { history, at, tick } = setup();
    await history.record(1, { t: at(), kind: 'click', role: 'button', name: 'Old' });
    tick(31 * MIN);
    await history.record(1, { t: at(), kind: 'click', role: 'button', name: 'New' });

    expect(await history.lines(1)).toEqual(['just now: clicked button "New"']);
  });

  it('bumps the clock on an exact repeat rather than writing a second line', async () => {
    const { history, at, tick } = setup();
    await history.record(1, { t: at(), kind: 'click', role: 'button', name: 'Load more' });
    tick(5000);
    await history.record(1, { t: at(), kind: 'click', role: 'button', name: 'Load more' });

    const entries = await history.entries(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.t).toBe(at());
  });

  it('records a top-frame navigation without its query, by the way it happened', async () => {
    const { history } = setup();
    await history.recordNavigation({ tabId: 1, frameId: 0, url: 'https://shop.example/cart?session=secret', transitionType: 'link' });
    await history.recordNavigation({ tabId: 1, frameId: 1, url: 'https://ads.example/frame', transitionType: 'link' });

    const lines = await history.lines(1);
    expect(lines).toEqual(['just now: followed a link to shop.example/cart']);
    expect(lines.join()).not.toContain('secret');
  });

  it('reads a back step off the transition qualifiers', async () => {
    const { history } = setup();
    await history.recordNavigation({
      tabId: 1,
      frameId: 0,
      url: 'https://shop.example/p/pour-over-set',
      transitionType: 'link',
      transitionQualifiers: ['forward_back'],
    });
    expect(await history.lines(1)).toEqual(['just now: went back to shop.example/p/pour-over-set']);
  });

  it('records what carat itself did, for the engine to call on accept and dismiss', async () => {
    const { history } = setup();
    await history.recordAccepted(1, 'click button "Save"');
    await history.recordDismissed(1, 'fill "Search"');

    expect(await history.lines(1)).toEqual([
      'just now: accepted suggestion: click button "Save"',
      'just now: dismissed suggestion: fill "Search"',
    ]);
  });

  it('notes the tab a new one was opened from, and forgets a tab that closed', async () => {
    const { history } = setup();
    await history.recordOpened(7, 3);
    expect(await history.lines(7)).toEqual(['just now: opened from tab 3']);

    await history.forget(7);
    expect(await history.lines(7)).toEqual([]);
  });

  it('wires itself to webNavigation and the tab events in one call', async () => {
    const { history } = setup();
    let onCommitted!: (d: { tabId: number; frameId: number; url: string; transitionType?: string }) => void;
    let onCreated!: (t: { id?: number; openerTabId?: number }) => void;
    history.attach(
      { onCommitted: { addListener: (cb) => (onCommitted = cb) } },
      { onCreated: { addListener: (cb) => (onCreated = cb) }, onRemoved: { addListener: () => undefined } },
    );

    onCommitted({ tabId: 4, frameId: 0, url: 'https://shop.example/', transitionType: 'typed' });
    onCreated({ id: 5, openerTabId: 4 });
    await history.flush();

    expect(await history.lines(4)).toEqual(['just now: typed the address shop.example']);
    expect(await history.lines(5)).toEqual(['just now: opened from tab 4']);
  });
});

describe('the content-side recorder', () => {
  const ctx = {
    isValid: true,
    setTimeout: (fn: () => void, ms: number) => Number(setTimeout(fn, ms)),
    addEventListener: (target: EventTarget, type: string, fn: EventListener, opts?: boolean | AddEventListenerOptions) =>
      target.addEventListener(type, fn, opts),
    onInvalidated: () => () => undefined,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function record(html: string) {
    document.body.innerHTML = html;
    const entries: HistoryEntry[] = [];
    const recorder = startHistoryRecorder(ctx, document, { emit: (e) => entries.push(e), now: () => 1_000 });
    return { entries, recorder };
  }

  it('records a click on the control under the pointer', () => {
    const { entries } = record('<button><span>Add to cart</span></button>');
    document.querySelector('span')!.dispatchEvent(new Event('click', { bubbles: true }));

    expect(entries).toEqual([{ t: 1000, kind: 'click', role: 'button', name: 'Add to cart' }]);
  });

  it('gathers a typing burst into one entry once the keys stop', () => {
    const { entries } = record('<label for="q">Search</label><input id="q">');
    const field = document.getElementById('q') as HTMLInputElement;
    for (const value of ['m', 'mo', 'moms pan']) {
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(entries).toEqual([]);

    vi.advanceTimersByTime(HISTORY_TIMING.typeDebounceMs);
    expect(entries).toEqual([{ t: 1000, kind: 'type', name: 'Search', value: 'moms pan' }]);
  });

  it('truncates a long typed value', () => {
    const { entries } = record('<label for="q">Search</label><input id="q">');
    const field = document.getElementById('q') as HTMLInputElement;
    field.value = 'a'.repeat(80);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(HISTORY_TIMING.typeDebounceMs);

    expect(entries[0]).toMatchObject({ kind: 'type' });
    expect((entries[0] as { value: string }).value).toHaveLength(HISTORY_LIMITS.valueChars);
  });

  it('never records what was typed into a password, card or code field', () => {
    const { entries } = record(`
      <label for="pw">Password</label><input id="pw" type="password">
      <label for="cc">Card number</label><input id="cc" autocomplete="cc-number">
    `);
    for (const id of ['pw', 'cc']) {
      const field = document.getElementById(id) as HTMLInputElement;
      field.value = '4111111111111111';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(HISTORY_TIMING.typeDebounceMs);
    }

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({ kind: 'type', value: '' });
      expect(describeEntry(entry)).not.toContain('4111');
    }
  });

  it('closes a typing burst when the user clicks something', () => {
    const { entries } = record('<label for="q">Search</label><input id="q"><button>Go</button>');
    const field = document.getElementById('q') as HTMLInputElement;
    field.value = 'boots';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }));

    expect(entries).toEqual([
      { t: 1000, kind: 'type', name: 'Search', value: 'boots' },
      { t: 1000, kind: 'click', role: 'button', name: 'Go' },
    ]);
  });
});
