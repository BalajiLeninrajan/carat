import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChip } from '../src/chip';
import { anchorInFrame, placeAt } from '../src/chip/position';
import type { ScriptContext } from '../src/content';
import { FRAME_TIMING, HUB_TIMING, createFrameHub, findIframeFor, startFrameAgent, stamp } from '../src/frames';
import type { FrameReport, ToChild, ToTop } from '../src/frames';
import { inViewport, viewportRect } from '../src/scroll';
import { childDocuments } from '../src/snapshot/frames';

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

  it('takes the chip key from the child window, where a key in the frame is heard', () => {
    const { iframe, doc, win } = sameOriginFrame();
    lay(iframe, 0, 100, 400, 300);
    doc.body.innerHTML = '<input aria-label="Card number">';
    const input = doc.querySelector('input')!;
    lay(input, 10, 20, 200, 30);
    const chip = createChip(document);
    const onAccept = vi.fn();
    chip.show({ target: input, label: 'Fill Card number with "4242"', onAccept, onDismiss: () => undefined });
    input.focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    win.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });
});

describe('anchoring a control reported by a cross-origin frame', () => {
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
    controls: [
      { n: 1, role: 'textbox', name: 'Card number', state: 'required' },
      { n: 2, role: 'button', name: 'Pay now', risky: true },
    ],
    rects: { '1': { x: 10, y: 20, w: 200, h: 30 }, '2': { x: 10, y: 60, w: 100, h: 30 } },
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
    const anchor = hub.anchor(hub.frames()[0]!, '1')!;
    expect([anchor.left, anchor.top, anchor.width, anchor.height]).toEqual([110, 220, 200, 30]);
    expect(hub.anchor(hub.frames()[0]!, '9')).toBeNull();

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

  it('hands the outline the frame’s own controls, to splice in where its element sits', () => {
    const { iframe, win } = sameOriginFrame();
    const hub = createFrameHub(fakeCtx(), document, { onReport: () => undefined, onKey: () => undefined });
    fromFrame(win, stamp({ type: 'report', token: 'abc', reply: false, report: report() }));
    expect(hub.outlines()).toEqual([{ frame: iframe, token: 'abc', controls: report().controls }]);
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

    const pending = hub.perform(frame, { kind: 'outline', n: 1, action: 'fill', value: '4242 4242 4242 4242', host: 'shop.example' });
    const sent = posted.find((m) => m.type === 'perform') as Extract<ToChild, { type: 'perform' }>;
    expect(sent.req).toEqual({ kind: 'outline', n: 1, action: 'fill', value: '4242 4242 4242 4242', host: 'shop.example' });
    fromFrame(win, stamp({ type: 'performed', token: 'abc', seq: sent.seq, reply: { ok: true, outcome: 'done' } }));
    expect(await pending).toEqual({ ok: true, outcome: 'done' });

    const late = hub.perform(frame, { kind: 'outline', n: 2, action: 'click', value: '' });
    await tick(HUB_TIMING.performMs);
    expect(await late).toEqual({ ok: false });

    hub.arm(frame, 'Tab');
    expect(posted.at(-1)).toMatchObject({ type: 'arm', key: 'Tab' });
    fromFrame(win, stamp({ type: 'key', token: 'abc', key: 'Tab' }));
    expect(onKey).toHaveBeenCalledWith('Tab');
    hub.disarm();
    expect(posted.at(-1)).toMatchObject({ type: 'disarm' });
    fromFrame(win, stamp({ type: 'key', token: 'abc', key: 'Tab' }));
    expect(onKey).toHaveBeenCalledTimes(1);
    // A key under someone else's token, or from a window that is not the frame's, is ignored.
    fromFrame(win, stamp({ type: 'key', token: 'nope', key: 'Tab' }));
    fromFrame({ postMessage: vi.fn() } as unknown as Window, stamp({ type: 'key', token: 'abc', key: 'Tab' }));
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
  function agentIn(doc: Document) {
    const top = { postMessage: vi.fn<(msg: ToTop, origin: string) => void>() };
    const ctx = fakeCtx();
    const agent = startFrameAgent(ctx, doc, { top: top as unknown as Window });
    const fromTop = (msg: ToChild): void => {
      doc.defaultView!.dispatchEvent(new MessageEvent('message', { data: msg, source: top as unknown as Window }));
    };
    const sent = (): ToTop[] => top.postMessage.mock.calls.map((c) => c[0]);
    return { agent, ctx, top, fromTop, sent };
  }

  it('reports its own controls with boxes after the initial delay, again only when they change, and always when asked', async () => {
    const { doc } = sameOriginFrame();
    doc.body.innerHTML = '<main><input aria-label="Card number"><button>Pay now</button></main>';
    for (const el of doc.querySelectorAll('input,button')) lay(el, 10, 20, 200, 30);
    const { fromTop, sent } = agentIn(doc);
    await tick(FRAME_TIMING.initialMs);
    expect(sent()).toHaveLength(1);
    const first = sent()[0] as Extract<ToTop, { type: 'report' }>;
    expect(first.reply).toBe(false);
    expect(first.report.controls.map((c) => c.name)).toEqual(['Card number', 'Pay now']);
    expect(first.report.rects['1']).toEqual({ x: 10, y: 20, w: 200, h: 30 });

    // Same page, a focus: nothing new to say.
    doc.querySelector('input')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await tick(FRAME_TIMING.debounceMs);
    expect(sent()).toHaveLength(1);
    // Asked: a reply even though nothing changed.
    fromTop(stamp({ type: 'snapshot' }));
    await tick(0);
    expect(sent()).toHaveLength(2);
    expect((sent()[1] as Extract<ToTop, { type: 'report' }>).reply).toBe(true);
  });

  it('performs a fill or a click on the control it numbered, from the top window only', async () => {
    const { doc } = sameOriginFrame();
    doc.body.innerHTML = '<main><input aria-label="Card number"><button>Pay now</button></main>';
    for (const el of doc.querySelectorAll('input,button')) lay(el, 10, 20, 200, 30);
    const clicks = vi.fn();
    doc.querySelector('button')!.addEventListener('click', clicks);
    const { fromTop, sent, top } = agentIn(doc);
    await tick(FRAME_TIMING.initialMs);

    fromTop(stamp({ type: 'perform', seq: 7, req: { kind: 'outline', n: 1, action: 'fill', value: '4242 4242 4242 4242', host: 'shop.example' } }));
    await tick(0);
    expect(doc.querySelector('input')!.value).toBe('4242 4242 4242 4242');
    expect(sent().at(-1)).toMatchObject({ type: 'performed', seq: 7, reply: { ok: true, outcome: 'done' } });

    fromTop(stamp({ type: 'perform', seq: 8, req: { kind: 'outline', n: 2, action: 'click', value: '' } }));
    await tick(0);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(sent().at(-1)).toMatchObject({ type: 'performed', seq: 8, reply: { ok: true } });

    fromTop(stamp({ type: 'perform', seq: 9, req: { kind: 'outline', n: 99, action: 'fill', value: 'x', host: 'shop.example' } }));
    await tick(0);
    expect(sent().at(-1)).toMatchObject({ type: 'performed', seq: 9, reply: { ok: false } });

    // The same request from a window that is not the top is ignored.
    const before = clicks.mock.calls.length;
    doc.defaultView!.dispatchEvent(
      new MessageEvent('message', {
        data: stamp({ type: 'perform', seq: 10, req: { kind: 'outline', n: 2, action: 'click', value: '' } }),
        source: doc.defaultView,
      }),
    );
    await tick(0);
    expect(clicks.mock.calls.length).toBe(before);
    expect(top.postMessage.mock.calls.some((c) => (c[0] as { seq?: number }).seq === 10)).toBe(false);
  });

  it('takes the armed key in the frame and relays it, relays Esc and typing, and stops when disarmed', async () => {
    const { doc, win } = sameOriginFrame();
    doc.body.innerHTML = '<input aria-label="CVC">';
    const { fromTop, sent } = agentIn(doc);
    const press = (key: string): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      win.dispatchEvent(e);
      return e;
    };
    expect(press('Tab').defaultPrevented).toBe(false);
    fromTop(stamp({ type: 'arm', key: 'Tab' }));
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(press('Escape').defaultPrevented).toBe(true);
    doc.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sent().map((m) => (m as { key?: string }).key)).toEqual(['Tab', 'Escape', 'typed']);
    fromTop(stamp({ type: 'disarm' }));
    expect(press('Tab').defaultPrevented).toBe(false);
    expect(sent()).toHaveLength(3);
  });
});
