import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChip } from '../src/chip';
import { anchorInFrame, placeAt } from '../src/chip/position';
import type { ScriptContext } from '../src/content';
import { FRAME_TIMING, HUB_TIMING, createFrameHub, findIframeFor, mergeElements, mergeFields, startFrameAgent, stamp } from '../src/frames';
import type { FrameReport, ToChild, ToTop } from '../src/frames';
import { enumerateElements } from '../src/interact';
import { inViewport, viewportRect } from '../src/scroll';
import { childDocuments, enumerateFields } from '../src/snapshot';

vi.mock('../src/messaging', () => ({ safeSendMessage: vi.fn(async () => undefined) }));

function fakeCtx(): ScriptContext & { invalidate(): void } {
  const onInvalid: Array<() => void> = [];
  const ctx = {
    isValid: true,
    setTimeout: (fn: () => void, ms?: number) => window.setTimeout(fn, ms),
    addEventListener(target: EventTarget, type: string, handler: EventListener, options?: unknown) {
      target.addEventListener(type, handler, options as AddEventListenerOptions);
    },
    onInvalidated(cb: () => void) {
      onInvalid.push(cb);
      return () => undefined;
    },
    invalidate() {
      ctx.isValid = false;
      onInvalid.forEach((cb) => cb());
    },
  };
  return ctx as unknown as ScriptContext & { invalidate(): void };
}

function lay(el: Element, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = () => new DOMRect(left, top, width, height);
}

/** A same-origin child frame with a document of its own, as jsdom builds one for an attached iframe. */
function sameOriginFrame(): { iframe: HTMLIFrameElement; doc: Document; win: Window } {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const doc = iframe.contentDocument!;
  return { iframe, doc, win: iframe.contentWindow! };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('same-origin frames, read directly', () => {
  it('lists the child document, offsets its boxes by the frame element, and numbers it', () => {
    const { iframe, doc } = sameOriginFrame();
    lay(iframe, 100, 200, 400, 300);
    doc.body.innerHTML = '<input aria-label="Card number">';
    const input = doc.querySelector('input')!;
    lay(input, 10, 20, 200, 30);
    expect(childDocuments(document).map((c) => [c.doc, c.num])).toEqual([[doc, 1]]);
    const rect = viewportRect(input, window);
    expect([rect.left, rect.top, rect.width, rect.height]).toEqual([110, 220, 200, 30]);
    expect(inViewport(input, window)).toBe(true);
    lay(iframe, 100, 5000, 400, 300);
    expect(inViewport(input, window)).toBe(false);
  });

  it('enumerates fields and elements inside the child with fr set and the real element in the registry', () => {
    const { iframe, doc } = sameOriginFrame();
    lay(iframe, 0, 100, 400, 300);
    document.body.insertAdjacentHTML('afterbegin', '<input aria-label="Email">');
    lay(document.querySelector('input')!, 0, 10, 300, 30);
    doc.body.innerHTML = '<input aria-label="Card number"><button>Pay now</button><button>Continue</button>';
    for (const el of doc.querySelectorAll('input,button')) lay(el, 10, 20, 200, 30);

    const fields = enumerateFields(document);
    expect(fields.descriptors.map((d) => [d.al, d.fr])).toEqual([
      ['Email', undefined],
      ['Card number', 1],
    ]);
    expect(fields.registry.get('f1')!.el).toBe(doc.querySelector('input'));
    expect(fields.registry.get('f1')!.el.getAttribute('data-carat-id')).toBe('f1');

    const elements = enumerateElements(document);
    expect(elements.descriptors.map((d) => [d.nm, d.fr, d.m])).toEqual([['Continue', 1, undefined]]);
    // Continue is the page's primary action even in a frame; a money button is never promoted to one.
    const withPay = enumerateElements(document, window, { allowPayments: true });
    expect(withPay.descriptors.map((d) => [d.nm, d.fr, d.m, d.p])).toEqual([
      ['Continue', 1, undefined, 1],
      ['Pay now', 1, 1, undefined],
    ]);
  });

  it('takes the chip key from the child window, where a key in the frame is heard', () => {
    const { iframe, doc, win } = sameOriginFrame();
    lay(iframe, 0, 100, 400, 300);
    doc.body.innerHTML = '<input aria-label="Card number">';
    const input = doc.querySelector('input')!;
    lay(input, 10, 20, 200, 30);
    const chip = createChip(document);
    const onAccept = vi.fn();
    chip.show({ target: input, value: '4242', onAccept, onDismiss: () => undefined });
    input.focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    win.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });
});

describe('anchoring a field reported by a cross-origin frame', () => {
  it('adds the frame box to the inner box and clips to the frame', () => {
    const frame = new DOMRect(100, 200, 400, 300);
    const inside = anchorInFrame(frame, { x: 20, y: 30, w: 200, h: 40 });
    expect([inside.left, inside.top, inside.width, inside.height]).toEqual([120, 230, 200, 40]);
    const clipped = anchorInFrame(frame, { x: 350, y: 280, w: 200, h: 40 });
    expect([clipped.left, clipped.top, clipped.width, clipped.height]).toEqual([450, 480, 50, 20]);
    const outside = anchorInFrame(frame, { x: -300, y: 30, w: 200, h: 40 });
    expect(outside.width).toBe(0);
    // And the chip then sits under that box like any other.
    expect(placeAt(inside, 120, 28, 1024, 768)).toEqual({ top: 276, left: 120, visible: true });
  });
});

describe('frame hub', () => {
  const report = (over: Partial<FrameReport> = {}): FrameReport => ({
    fields: [{ i: 'f0', t: 'input:text', al: 'Card number', w: 'm' }],
    elements: [{ i: 'e0', r: 'button', nm: 'Pay now', p: 1, m: 1 }],
    rects: { f0: { x: 10, y: 20, w: 200, h: 30 }, e0: { x: 10, y: 60, w: 100, h: 30 } },
    fingerprints: { f0: 'input|text|cardnumber|||Card number' },
    entries: { e0: { role: 'button', name: 'Pay now', money: true } },
    ...over,
  });
  const fromFrame = (source: Window, msg: ToTop): void => {
    window.dispatchEvent(new MessageEvent('message', { data: msg, source }));
  };

  it('keeps a report from a window inside the page, matched to its frame element, and ignores one from elsewhere', () => {
    const { iframe, win } = sameOriginFrame();
    lay(iframe, 100, 200, 400, 300);
    const onReport = vi.fn();
    const hub = createFrameHub(fakeCtx(), document, { onReport, onKey: () => undefined });
    fromFrame(win, stamp({ type: 'report', token: 'abc', reply: false, report: report() }));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(hub.frames().map((f) => [f.token, f.iframe])).toEqual([['abc', iframe]]);
    expect(hub.numberOf(hub.frames()[0]!)).toBe(1);
    const anchor = hub.anchor(hub.frames()[0]!, 'f0')!;
    expect([anchor.left, anchor.top, anchor.width, anchor.height]).toEqual([110, 220, 200, 30]);
    expect(hub.anchor(hub.frames()[0]!, 'f9')).toBeNull();

    const stranger = { postMessage: vi.fn() } as unknown as Window;
    fromFrame(stranger, stamp({ type: 'report', token: 'zzz', reply: false, report: report() }));
    expect(hub.frames()).toHaveLength(1);
    // Data that is not a frame message, or a malformed report, is dropped without a trace.
    window.dispatchEvent(new MessageEvent('message', { data: { carat: 'frame', type: 'report' }, source: win }));
    fromFrame(win, { carat: 'carat-frame', v: 1, type: 'report', token: 'bad', reply: false, report: {} as FrameReport });
    expect(hub.frames()).toHaveLength(1);
    expect(findIframeFor(document, win)).toBe(iframe);
    expect(findIframeFor(document, stranger)).toBeNull();
  });

  it('merges frame descriptors after its own, renumbered, flagged fr, and re-marked o against the top viewport', () => {
    const { iframe, win } = sameOriginFrame();
    lay(iframe, 0, 100, 400, 300);
    const hub = createFrameHub(fakeCtx(), document, { onReport: () => undefined, onKey: () => undefined });
    fromFrame(win, stamp({ type: 'report', token: 'abc', reply: false, report: report({ rects: { f0: { x: 10, y: 20, w: 200, h: 30 }, e0: { x: 10, y: 900, w: 100, h: 30 } } }) }));
    const frame = hub.frames()[0]!;
    const merged = [{ frame, num: hub.numberOf(frame), onScreen: (id: string) => hub.anchor(frame, id) !== null }];
    const own = { descriptors: [{ i: 'f0', t: 'input:text', al: 'Email' }], registry: new Map([['f0', { el: document.body, fingerprint: 'x' }]]) };
    const fields = mergeFields(own, merged);
    expect(fields.descriptors).toEqual([
      { i: 'f0', t: 'input:text', al: 'Email' },
      { i: 'f1', t: 'input:text', al: 'Card number', w: 'm', fr: 1 },
    ]);
    expect(fields.registry.get('f1')).toEqual({ el: iframe, fingerprint: 'input|text|cardnumber|||Card number', frame: { token: 'abc', remoteId: 'f0' } });
    const elements = mergeElements({ descriptors: [], registry: new Map() }, merged);
    // The Pay button sits 900px into a 300px-tall frame: off-screen from the top's point of view.
    expect(elements.descriptors).toEqual([{ i: 'e0', r: 'button', nm: 'Pay now', p: 1, m: 1, fr: 1, o: 1 }]);
    expect(elements.registry.get('e0')).toMatchObject({ el: iframe, role: 'button', name: 'Pay now', key: 'button|pay now', money: true, frame: { token: 'abc', remoteId: 'e0' } });
  });

  it('asks frames for a fresh report and waits for the replies or the cap, without re-triggering a snapshot', async () => {
    const { win } = sameOriginFrame();
    const posted: ToChild[] = [];
    win.postMessage = ((msg: ToChild) => void posted.push(msg)) as typeof win.postMessage;
    const onReport = vi.fn();
    const hub = createFrameHub(fakeCtx(), document, { onReport, onKey: () => undefined });
    fromFrame(win, stamp({ type: 'report', token: 'abc', reply: false, report: report() }));
    let settled = false;
    void hub.refresh().then(() => (settled = true));
    await tick(0);
    expect(posted.map((m) => m.type)).toEqual(['snapshot']);
    expect(settled).toBe(false);
    fromFrame(win, stamp({ type: 'report', token: 'abc', reply: true, report: report() }));
    await tick(0);
    expect(settled).toBe(true);
    expect(onReport).toHaveBeenCalledTimes(1);

    let capped = false;
    void hub.refresh().then(() => (capped = true));
    await tick(HUB_TIMING.refreshMs);
    expect(capped).toBe(true);
  });

  it('performs through the frame and resolves on its reply, or with ok false after the cap; arms and relays keys from the armed frame only', async () => {
    const { win } = sameOriginFrame();
    const posted: ToChild[] = [];
    win.postMessage = ((msg: ToChild) => void posted.push(msg)) as typeof win.postMessage;
    const onKey = vi.fn();
    const hub = createFrameHub(fakeCtx(), document, { onReport: () => undefined, onKey });
    fromFrame(win, stamp({ type: 'report', token: 'abc', reply: false, report: report() }));
    const frame = hub.frames()[0]!;

    const pending = hub.perform(frame, { kind: 'fill', id: 'f0', value: '4242 4242 4242 4242', host: 'shop.example' });
    const sent = posted.find((m) => m.type === 'perform') as Extract<ToChild, { type: 'perform' }>;
    expect(sent.req).toEqual({ kind: 'fill', id: 'f0', value: '4242 4242 4242 4242', host: 'shop.example' });
    fromFrame(win, stamp({ type: 'performed', token: 'abc', seq: sent.seq, reply: { ok: true, outcome: 'done' } }));
    expect(await pending).toEqual({ ok: true, outcome: 'done' });

    const late = hub.perform(frame, { kind: 'interact', id: 'e0', verb: 'click', value: 'Pay now' });
    await tick(HUB_TIMING.performMs);
    expect(await late).toEqual({ ok: false });

    hub.arm(frame, 'Enter');
    expect(posted.at(-1)).toMatchObject({ type: 'arm', key: 'Enter' });
    fromFrame(win, stamp({ type: 'key', token: 'abc', key: 'Enter' }));
    expect(onKey).toHaveBeenCalledWith('Enter');
    hub.disarm();
    expect(posted.at(-1)).toMatchObject({ type: 'disarm' });
    fromFrame(win, stamp({ type: 'key', token: 'abc', key: 'Enter' }));
    expect(onKey).toHaveBeenCalledTimes(1);
    // A key under someone else's token, or from a window that is not the frame's, is ignored.
    fromFrame(win, stamp({ type: 'key', token: 'nope', key: 'Enter' }));
    fromFrame({ postMessage: vi.fn() } as unknown as Window, stamp({ type: 'key', token: 'abc', key: 'Enter' }));
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('forgets a frame whose element left the page', () => {
    const { iframe, win } = sameOriginFrame();
    const hub = createFrameHub(fakeCtx(), document, { onReport: () => undefined, onKey: () => undefined });
    fromFrame(win, stamp({ type: 'report', token: 'abc', reply: false, report: report() }));
    expect(hub.frames()).toHaveLength(1);
    iframe.remove();
    expect(hub.frames()).toHaveLength(0);
  });
});

describe('frame agent', () => {
  function agentIn(doc: Document, allowPayments = false) {
    const top = { postMessage: vi.fn<(msg: ToTop, origin: string) => void>() };
    const ctx = fakeCtx();
    const agent = startFrameAgent(ctx, doc, { allowPayments: async () => allowPayments, top: top as unknown as Window });
    const fromTop = (msg: ToChild): void => {
      doc.defaultView!.dispatchEvent(new MessageEvent('message', { data: msg, source: top as unknown as Window }));
    };
    const sent = (): ToTop[] => top.postMessage.mock.calls.map((c) => c[0]);
    return { agent, ctx, top, fromTop, sent };
  }

  it('reports its fields and elements with boxes after the initial delay, again only when they change, and always when asked', async () => {
    const { doc } = sameOriginFrame();
    doc.body.innerHTML = '<input aria-label="Card number"><button>Pay now</button>';
    for (const el of doc.querySelectorAll('input,button')) lay(el, 10, 20, 200, 30);
    const { fromTop, sent } = agentIn(doc);
    await tick(FRAME_TIMING.initialMs);
    expect(sent()).toHaveLength(1);
    const first = sent()[0] as Extract<ToTop, { type: 'report' }>;
    expect(first.reply).toBe(false);
    expect(first.report.fields.map((f) => f.al)).toEqual(['Card number']);
    expect(first.report.elements).toEqual([]); // money is off
    expect(first.report.rects.f0).toEqual({ x: 10, y: 20, w: 200, h: 30 });
    expect(first.report.fingerprints.f0).toContain('Card number');

    // Same page, a focus: nothing new to say.
    doc.querySelector('input')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await tick(FRAME_TIMING.debounceMs);
    expect(sent()).toHaveLength(1);
    // Asked: a reply even though nothing changed.
    fromTop(stamp({ type: 'snapshot' }));
    await tick(0);
    expect(sent()).toHaveLength(2);
    expect((sent()[1] as Extract<ToTop, { type: 'report' }>).reply).toBe(true);
    // The page changed: an unasked-for report.
    doc.body.insertAdjacentHTML('beforeend', '<input aria-label="Expiry">');
    lay(doc.querySelectorAll('input')[1]!, 10, 60, 100, 30);
    await tick(FRAME_TIMING.debounceMs);
    expect(sent()).toHaveLength(3);
    expect((sent()[2] as Extract<ToTop, { type: 'report' }>).report.fields.map((f) => f.al)).toEqual(['Card number', 'Expiry']);
  });

  it('describes money controls when allowed, and reports their entries', async () => {
    const { doc } = sameOriginFrame();
    doc.body.innerHTML = '<button>Pay now</button>';
    lay(doc.querySelector('button')!, 10, 20, 200, 30);
    const { sent } = agentIn(doc, true);
    await tick(FRAME_TIMING.initialMs);
    const r = (sent()[0] as Extract<ToTop, { type: 'report' }>).report;
    expect(r.elements).toEqual([{ i: 'e0', r: 'button', nm: 'Pay now', m: 1 }]);
    expect(r.entries.e0).toEqual({ role: 'button', name: 'Pay now', money: true });
  });

  it('performs a fill or a click on request, from the top window only, and answers with the outcome', async () => {
    const { doc } = sameOriginFrame();
    doc.body.innerHTML = '<input aria-label="Card number"><button>Pay now</button>';
    for (const el of doc.querySelectorAll('input,button')) lay(el, 10, 20, 200, 30);
    const clicks = vi.fn();
    doc.querySelector('button')!.addEventListener('click', clicks);
    const { fromTop, sent, top } = agentIn(doc, true);
    await tick(FRAME_TIMING.initialMs);

    fromTop(stamp({ type: 'perform', seq: 7, req: { kind: 'fill', id: 'f0', value: '4242 4242 4242 4242', host: 'shop.example' } }));
    await tick(0);
    expect(doc.querySelector('input')!.value).toBe('4242 4242 4242 4242');
    expect(sent().at(-1)).toMatchObject({ type: 'performed', seq: 7, reply: { ok: true, outcome: 'done' } });

    fromTop(stamp({ type: 'perform', seq: 8, req: { kind: 'interact', id: 'e0', verb: 'click', value: 'Pay now' } }));
    await tick(0);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(sent().at(-1)).toMatchObject({ type: 'performed', seq: 8, reply: { ok: true } });

    fromTop(stamp({ type: 'perform', seq: 9, req: { kind: 'fill', id: 'f7', value: 'x', host: 'shop.example' } }));
    await tick(0);
    expect(sent().at(-1)).toMatchObject({ type: 'performed', seq: 9, reply: { ok: false } });

    // The same request from a window that is not the top is ignored.
    const before = clicks.mock.calls.length;
    doc.defaultView!.dispatchEvent(new MessageEvent('message', { data: stamp({ type: 'perform', seq: 10, req: { kind: 'interact', id: 'e0', verb: 'click', value: 'Pay now' } }), source: doc.defaultView }));
    await tick(0);
    expect(clicks.mock.calls.length).toBe(before);
    expect(top.postMessage.mock.calls.some((c) => (c[0] as { seq?: number }).seq === 10)).toBe(false);
  });

  it('takes the armed key in the frame and relays it, lets Tab through when armed for Enter, relays Esc and typing, and stops when disarmed', async () => {
    const { doc, win } = sameOriginFrame();
    doc.body.innerHTML = '<input aria-label="CVC">';
    const { fromTop, sent } = agentIn(doc);
    const press = (key: string): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      win.dispatchEvent(e);
      return e;
    };
    expect(press('Tab').defaultPrevented).toBe(false);
    fromTop(stamp({ type: 'arm', key: 'Enter' }));
    expect(press('Tab').defaultPrevented).toBe(false);
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(press('Escape').defaultPrevented).toBe(true);
    doc.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent().map((m) => (m as { key?: string }).key)).toEqual(['Enter', 'Escape', 'typed']);
    fromTop(stamp({ type: 'disarm' }));
    expect(press('Enter').defaultPrevented).toBe(false);
    expect(sent()).toHaveLength(3);
  });
});
