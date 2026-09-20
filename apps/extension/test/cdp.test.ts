import { DEFAULT_SETTINGS, type Settings } from '@carat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebuggerApi } from '../src/background/cdp';
import { IDLE_DETACH_MS, __forTests, attachable, hasDebugger, isPaused, useDebuggerApi } from '../src/background/cdp';
import { createPageEvidence } from '../src/background/page-evidence';
import { readCdpEvidence } from '../src/outline/cdp';
import { NODE, PAY_FRAME, bookingReplies } from './fixtures/cdp-booking';

/**
 * A `chrome.debugger` that answers from a table. It records every attach,
 * detach and command, so a test can say what carat asked the browser for
 * without a browser.
 */
function fakeDebugger(replies: Record<string, unknown> = {}, fail?: (method: string) => string | undefined) {
  const attached = new Set<number>();
  const calls: Array<{ tabId: number; method: string; params?: object }> = [];
  const attaches: number[] = [];
  const detaches: number[] = [];
  let onDetach: ((source: { tabId?: number }, reason: string) => void) | undefined;
  let refuseAttach: string | undefined;

  const api: DebuggerApi = {
    async attach({ tabId }) {
      if (refuseAttach) throw new Error(refuseAttach);
      attaches.push(tabId);
      if (attached.has(tabId)) throw new Error('Another debugger is already attached');
      attached.add(tabId);
    },
    async detach({ tabId }) {
      detaches.push(tabId);
      attached.delete(tabId);
    },
    async sendCommand({ tabId }, method, params) {
      const why = fail?.(method);
      if (why) throw new Error(why);
      calls.push({ tabId, method, ...(params ? { params } : {}) });
      return replies[method] ?? {};
    },
    onDetach: {
      addListener(cb) {
        onDetach = cb;
      },
    },
  };

  return {
    api,
    calls,
    attaches,
    detaches,
    attached,
    methods: () => calls.map((c) => c.method),
    refuse(message: string) {
      refuseAttach = message;
    },
    fire(tabId: number, reason: string) {
      onDetach?.({ tabId }, reason);
    },
  };
}

function settingsWith(patch: Partial<Settings> = {}): () => Promise<Settings> {
  return async () => ({ ...DEFAULT_SETTINGS, ...patch });
}

const URL_BOOKING = 'https://ravineinn.com/book';

afterEach(() => {
  useDebuggerApi(null);
  vi.useRealTimers();
});

describe('the outline read from the accessibility tree', () => {
  it('numbers every operable node with its role, name, value and state', async () => {
    const fake = fakeDebugger(bookingReplies());
    const send = <T,>(method: string, params?: object) => fake.api.sendCommand({ tabId: 1 }, method, params) as Promise<T>;
    const evidence = await readCdpEvidence(send, { url: URL_BOOKING });

    expect(evidence.outline).toContain('PAGE: Book a room — Ravine Inn (https://ravineinn.com/book)');
    expect(evidence.outline).toContain('main:');
    expect(evidence.outline).toContain('heading(1) "Book a room"');
    expect(evidence.outline).toContain('form "Booking":');
    expect(evidence.outline).toContain('combobox "Guests" = "2 guests"');
    // The options sit under the combobox and are never numbered themselves.
    expect(evidence.outline).toContain('option "1 guest"');
    expect(evidence.outline).not.toMatch(/\[\d+\] option/);
    expect(evidence.controls.map((c) => c.name)).toEqual([
      'Guests',
      'Dates',
      'Email',
      'Confirm booking',
      'Cancellation policy',
      'Card number',
      'Pay',
    ]);
  });

  it('marks the button that opens a dialog, the focused field and the link’s host', async () => {
    const fake = fakeDebugger(bookingReplies());
    const send = <T,>(method: string, params?: object) => fake.api.sendCommand({ tabId: 1 }, method, params) as Promise<T>;
    const evidence = await readCdpEvidence(send, { url: URL_BOOKING });

    expect(evidence.outline).toContain('button "Dates" (collapsed, opens dialog)');
    expect(evidence.outline).toMatch(/>> FOCUSED \[3\] textbox "Email" \(required\)/);
    expect(evidence.focused).toBe(3);
    expect(evidence.outline).toContain('link "Cancellation policy" -> ravineinn.com');
    expect(evidence.controls.find((c) => c.name === 'Cancellation policy')?.host).toBe('ravineinn.com');
    // Paying, booking and confirming arm the chip for a second Tab.
    expect(evidence.controls.find((c) => c.name === 'Confirm booking')?.risky).toBe(true);
  });

  it('leaves out what is below the fold and says how much is missing', async () => {
    const fake = fakeDebugger(bookingReplies());
    const send = <T,>(method: string, params?: object) => fake.api.sendCommand({ tabId: 1 }, method, params) as Promise<T>;
    const evidence = await readCdpEvidence(send, { url: URL_BOOKING });

    expect(evidence.outline).not.toContain('Back to top');
    expect(evidence.outline).toContain('(2.0 more screens below; 1 control not shown)');
    expect(evidence.scroll).toEqual({ y: 0, pages: 3, more: true });
  });

  it('writes the screens-above line once the page is scrolled', async () => {
    const fake = fakeDebugger(bookingReplies(600));
    const send = <T,>(method: string, params?: object) => fake.api.sendCommand({ tabId: 1 }, method, params) as Promise<T>;
    const evidence = await readCdpEvidence(send, { url: URL_BOOKING });

    expect(evidence.outline.split('\n')[0]).toBe('(1.0 screens above)');
    expect(evidence.scroll.y).toBe(1);
  });

  it('numbers the controls inside a cross-origin frame and keeps their frame with them', async () => {
    const fake = fakeDebugger(bookingReplies());
    const send = <T,>(method: string, params?: object) => fake.api.sendCommand({ tabId: 1 }, method, params) as Promise<T>;
    const evidence = await readCdpEvidence(send, { url: URL_BOOKING });

    const card = evidence.controls.find((c) => c.name === 'Card number')!;
    expect(evidence.nodes.get(card.n)).toMatchObject({ backendNodeId: NODE.cardNumber, frameId: PAY_FRAME });
    // A control in the top frame is not tagged with a frame at all.
    const email = evidence.controls.find((c) => c.name === 'Email')!;
    expect(evidence.nodes.get(email.n)?.frameId).toBeUndefined();
  });

  it('falls back to DOM.getBoxModel for the boxes when there is no page snapshot', async () => {
    const replies = { ...bookingReplies(), 'DOM.getBoxModel': { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } } };
    delete (replies as Record<string, unknown>)['DOMSnapshot.captureSnapshot'];
    const fake = fakeDebugger(replies, (m) => (m === 'DOMSnapshot.captureSnapshot' ? 'not supported' : undefined));
    const send = <T,>(method: string, params?: object) => fake.api.sendCommand({ tabId: 1 }, method, params) as Promise<T>;
    const evidence = await readCdpEvidence(send, { url: URL_BOOKING });

    expect(fake.methods()).toContain('DOM.getBoxModel');
    expect(evidence.nodes.get(1)?.box).toEqual({ x: 10, y: 20, w: 100, h: 40 });
    // Without geometry nothing is gated, so the control below the fold is still described.
    expect(evidence.outline).toContain('Back to top');
  });
});

describe('the debugger session', () => {
  it('attaches once per tab, however many reads ask for it', async () => {
    const fake = fakeDebugger(bookingReplies());
    useDebuggerApi(fake.api);
    const evidence = createPageEvidence({ settings: settingsWith() });

    await Promise.all([evidence.read(7, URL_BOOKING), evidence.read(7, URL_BOOKING)]);
    await evidence.read(7, URL_BOOKING);

    expect(fake.attaches).toEqual([7]);
    expect(fake.methods()).toContain('Accessibility.enable');
    expect(fake.methods().filter((m) => m === 'Accessibility.enable')).toHaveLength(1);
  });

  it('asks Chrome to flatten child targets into the session, so a frame is in the tree', async () => {
    const fake = fakeDebugger(bookingReplies());
    useDebuggerApi(fake.api);
    await createPageEvidence({ settings: settingsWith() }).read(7, URL_BOOKING);

    const autoAttach = fake.calls.find((c) => c.method === 'Target.setAutoAttach');
    expect(autoAttach?.params).toMatchObject({ autoAttach: true, flatten: true });
  });

  it('lets go of the tab after a minute of nobody reading it', async () => {
    vi.useFakeTimers();
    const fake = fakeDebugger(bookingReplies());
    useDebuggerApi(fake.api);
    await createPageEvidence({ settings: settingsWith() }).read(7, URL_BOOKING);

    expect(fake.attached.has(7)).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE_DETACH_MS + 10);
    expect(fake.detaches).toContain(7);
  });

  it('lets go when the tab closes', async () => {
    const fake = fakeDebugger(bookingReplies());
    useDebuggerApi(fake.api);
    const evidence = createPageEvidence({ settings: settingsWith() });
    await evidence.read(7, URL_BOOKING);

    evidence.forget(7);
    await Promise.resolve();
    expect(fake.detaches).toContain(7);
  });

  it('lets go when the tab navigates somewhere carat may not read', async () => {
    const fake = fakeDebugger(bookingReplies());
    useDebuggerApi(fake.api);
    const evidence = createPageEvidence({ settings: settingsWith() });
    await evidence.read(7, URL_BOOKING);

    evidence.navigated(7, 'chrome://settings');
    await Promise.resolve();
    expect(fake.detaches).toContain(7);
  });

  it('reads the DOM instead once DevTools takes the debugger, until the tab is activated again', async () => {
    const fake = fakeDebugger(bookingReplies());
    useDebuggerApi(fake.api);
    const evidence = createPageEvidence({ settings: settingsWith() });
    expect((await evidence.read(7, URL_BOOKING)).source).toBe('cdp');

    __forTests.onDetached(7, 'replaced_with_devtools');
    expect(isPaused(7)).toBe(true);
    expect(await evidence.read(7, URL_BOOKING)).toEqual({ source: 'dom', reason: 'DevTools took the debugger' });

    evidence.activated(7);
    expect((await evidence.read(7, URL_BOOKING)).source).toBe('cdp');
  });

  it('never attaches to a Chrome page, the Web Store or a denylisted host', () => {
    expect(attachable(URL_BOOKING)).toBe(true);
    expect(attachable('chrome://extensions')).toBe(false);
    expect(attachable('chrome-extension://abc/options.html')).toBe(false);
    expect(attachable('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(attachable('https://accounts.google.com/signin')).toBe(false);
    expect(attachable(undefined)).toBe(false);
  });
});

describe('falling back to the DOM outline', () => {
  it('says the setting chose it', async () => {
    useDebuggerApi(fakeDebugger().api);
    const evidence = createPageEvidence({ settings: settingsWith({ evidence: 'dom' }) });
    expect(await evidence.read(7, URL_BOOKING)).toEqual({ source: 'dom', reason: 'the evidence setting is dom' });
  });

  it('says the attach failed, and repeats the browser’s own words', async () => {
    const fake = fakeDebugger(bookingReplies());
    fake.refuse('Cannot access a chrome:// URL');
    useDebuggerApi(fake.api);
    const reply = await createPageEvidence({ settings: settingsWith() }).read(7, URL_BOOKING);
    expect(reply.source).toBe('dom');
    expect(reply.reason).toBe('the debugger would not attach: Cannot access a chrome:// URL');
  });

  it('says the page is one carat does not attach to', async () => {
    useDebuggerApi(fakeDebugger(bookingReplies()).api);
    const evidence = createPageEvidence({ settings: settingsWith() });
    expect(await evidence.read(7, 'chrome://newtab')).toEqual({ source: 'dom', reason: 'carat does not attach to this page' });
  });

  it('says the site is switched off', async () => {
    useDebuggerApi(fakeDebugger(bookingReplies()).api);
    const evidence = createPageEvidence({ settings: settingsWith({ disabledHosts: ['ravineinn.com'] }) });
    expect(await evidence.read(7, URL_BOOKING)).toEqual({ source: 'dom', reason: 'carat is off for this site' });
  });

  it('says so when the browser has no debugger at all', async () => {
    useDebuggerApi(null);
    const before = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {};
    try {
      expect(hasDebugger()).toBe(false);
      const evidence = createPageEvidence({ settings: settingsWith() });
      expect(await evidence.read(7, URL_BOOKING)).toEqual({ source: 'dom', reason: 'this browser has no debugger' });
    } finally {
      (globalThis as { chrome?: unknown }).chrome = before;
    }
  });
});

describe('performing a numbered control', () => {
  let fake: ReturnType<typeof fakeDebugger>;
  let evidence: ReturnType<typeof createPageEvidence>;

  beforeEach(async () => {
    fake = fakeDebugger({
      ...bookingReplies(),
      'DOM.resolveNode': { object: { objectId: 'OBJ-1' } },
      'Runtime.callFunctionOn': { result: { value: 'ok' } },
    });
    useDebuggerApi(fake.api);
    evidence = createPageEvidence({ settings: settingsWith() });
    await evidence.read(7, URL_BOOKING);
  });

  it('points the page at the node so the page’s own paths can act on it', async () => {
    expect(await evidence.resolve(7, 3, 'tok-1')).toEqual({ ok: true });
    const call = fake.calls.find((c) => c.method === 'Runtime.callFunctionOn');
    expect(call?.params).toMatchObject({ objectId: 'OBJ-1' });
    expect(JSON.stringify(call?.params)).toContain('carat-cdp-target');
  });

  it('refuses to point at a control in a child frame; the debugger performs there', async () => {
    const read = await evidence.read(7, URL_BOOKING);
    const card = read.controls!.find((c) => c.name === 'Card number')!;
    expect(await evidence.resolve(7, card.n, 'tok-2')).toEqual({ ok: false, reason: 'the control is in a child frame' });
    expect(await evidence.perform(7, card.n, 'fill', '4242')).toEqual({ ok: true });
    expect(fake.calls.some((c) => c.method === 'DOM.resolveNode' && JSON.stringify(c.params).includes(String(NODE.cardNumber)))).toBe(true);
  });

  it('clicks through DOM.resolveNode and Runtime.callFunctionOn', async () => {
    expect(await evidence.perform(7, 4, 'click', '')).toEqual({ ok: true });
    const resolve = fake.calls.find((c) => c.method === 'DOM.resolveNode');
    expect(resolve?.params).toEqual({ backendNodeId: NODE.confirm });
  });

  it('focuses through DOM.focus, which is what a fill leans on', async () => {
    expect(await evidence.perform(7, 3, 'focus', '')).toEqual({ ok: true });
    expect(fake.calls.find((c) => c.method === 'DOM.focus')?.params).toEqual({ backendNodeId: NODE.email });
  });

  it('refuses a number the last read never handed out', async () => {
    expect(await evidence.perform(7, 99, 'click', '')).toEqual({ ok: false, reason: 'that control is no longer numbered' });
  });
});
