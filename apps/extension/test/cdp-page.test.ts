import type { NextAction } from '@carat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChip } from '../src/chip';
import type { ScriptContext } from '../src/content';
import { startActions } from '../src/content/action-scheduler';
import { readEvidence, startCdpTargets } from '../src/content/evidence';
import type { FrameHub } from '../src/frames';
import { TARGET_EVENT } from '../src/interact/cdp-perform';
import { safeSendMessage } from '../src/messaging';

vi.mock('../src/messaging', () => ({ safeSendMessage: vi.fn(async () => undefined) }));

const sent = vi.mocked(safeSendMessage);
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

/** What the worker sends back for a page it read through the debugger. */
const CDP_REPLY = {
  source: 'cdp' as const,
  outline: 'PAGE: Book a room (https://ravineinn.com/book)\n  [1] textbox "Email" (required)\n  [2] button "Confirm booking"',
  controls: [
    { n: 1, role: 'textbox' as const, name: 'Email', state: 'required' },
    { n: 2, role: 'button' as const, name: 'Confirm booking', risky: true },
  ],
  focused: 1,
  scroll: { y: 0, pages: 3, more: true },
  boxes: [
    { n: 1, x: 20, y: 200, w: 300, h: 32 },
    { n: 2, x: 20, y: 250, w: 200, h: 40 },
  ],
};

const action = (over: Partial<NextAction> = {}): NextAction => ({
  kind: 'click',
  target: 2,
  value: '',
  label: 'Click "Confirm booking"',
  irreversible: false,
  confidence: 0.8,
  reason: '',
  ...over,
});

beforeEach(() => {
  sent.mockReset();
  document.body.innerHTML = '';
});
afterEach(() => {
  for (const ctx of live.splice(0)) ctx.invalidate();
  vi.useRealTimers();
});

describe('reading the page through the worker', () => {
  it('takes the worker’s outline and numbers, and keeps the page meta of its own', async () => {
    sent.mockImplementation((async (type: string) => (type === 'cdpEvidence' ? CDP_REPLY : undefined)) as unknown as typeof safeSendMessage);
    document.title = 'Book a room';

    const read = await readEvidence(document, window);

    expect(read.source).toBe('cdp');
    expect(read.reason).toBeUndefined();
    expect(read.request.outline).toBe(CDP_REPLY.outline);
    expect(read.request.controls.map((c) => c.name)).toEqual(['Email', 'Confirm booking']);
    expect(read.request.focused).toBe(1);
    expect(read.request.page.title).toBe('Book a room');
    expect(read.request.page.scroll).toEqual({ y: 0, pages: 3, more: true });
    // No element: the number and the box are what the page holds.
    expect(read.registry.get(2)).toEqual({ cdp: { n: 2, rect: new DOMRect(20, 250, 200, 40) } });
  });

  it('builds the outline itself when the worker says no, and carries the reason', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    sent.mockImplementation((async (type: string) =>
      type === 'cdpEvidence' ? { source: 'dom', reason: 'you dismissed the debugging banner' } : undefined) as unknown as typeof safeSendMessage);

    const read = await readEvidence(document, window);

    expect(read.source).toBe('dom');
    expect(read.reason).toBe('you dismissed the debugging banner');
    expect(read.request.controls.map((c) => c.name)).toEqual(['Title', 'Save']);
    expect(read.registry.get(1)?.el).toBe(document.querySelector('input'));
  });

  it('never asks the worker when the page was told not to', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    const read = await readEvidence(document, window, { debugger: false });
    expect(read.source).toBe('dom');
    expect(read.reason).toBe('the evidence setting is dom');
    expect(sent.mock.calls.filter((c) => c[0] === 'cdpEvidence')).toHaveLength(0);
  });
});

describe('the bridge back to an element', () => {
  it('hands over the element the worker pointed at, once, and only under its own token', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    const targets = startCdpTargets(fakeCtx(), document);
    const button = document.getElementById('go')!;

    button.dispatchEvent(new CustomEvent(TARGET_EVENT, { bubbles: true, composed: true, detail: 'tok-1' }));

    expect(targets.take('tok-2')).toBeNull();
    expect(targets.take('tok-1')).toBe(button);
    // Taken once: a second Tab must not act on a stale announcement.
    expect(targets.take('tok-1')).toBeNull();
  });
});

describe('performing a control the debugger numbered', () => {
  it('asks the worker to point at it, then acts on the element with the page’s own click', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><button id="confirm">Confirm booking</button></main>';
    const button = document.getElementById('confirm') as HTMLButtonElement;
    button.getBoundingClientRect = () => ({ top: 250, left: 20, bottom: 290, right: 220, width: 200, height: 40 }) as DOMRect;
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    // The worker's announcement, as the real one arrives: an event on the node itself.
    const targets = { take: () => button };

    sent.mockImplementation((async (type: string) => {
      if (type === 'cdpEvidence') return CDP_REPLY;
      if (type === 'nextAction') return { action: action() };
      if (type === 'cdpResolve') return { ok: true };
      return undefined;
    }) as unknown as typeof safeSendMessage);

    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames, targets });
    await vi.advanceTimersByTimeAsync(0);
    expect(chip.visible).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(50);

    expect(sent.mock.calls.some((c) => c[0] === 'cdpResolve')).toBe(true);
    expect(clicked).toHaveBeenCalled();
    // The page reached the element, so nothing had to go back through the debugger.
    expect(sent.mock.calls.some((c) => c[0] === 'cdpPerform')).toBe(false);
    chip.destroy();
  });

  it('goes back through the debugger when the page cannot reach the control', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main></main>';
    const remote = {
      ...CDP_REPLY,
      boxes: [
        { n: 1, x: 20, y: 200, w: 300, h: 32 },
        { n: 2, x: 20, y: 250, w: 200, h: 40, remote: true },
      ],
    };
    sent.mockImplementation((async (type: string) => {
      if (type === 'cdpEvidence') return remote;
      if (type === 'nextAction') return { action: action() };
      if (type === 'cdpPerform') return { ok: true };
      return undefined;
    }) as unknown as typeof safeSendMessage);

    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames, targets: { take: () => null } });
    await vi.advanceTimersByTimeAsync(0);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(50);

    // A control in a child frame is never announced to the page; the debugger performs.
    expect(sent.mock.calls.some((c) => c[0] === 'cdpResolve')).toBe(false);
    expect(sent.mock.calls.find((c) => c[0] === 'cdpPerform')?.[1]).toEqual({ n: 2, action: 'click', value: '' });
    chip.destroy();
  });

  it('tells the request and the debug panel which reader answered', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><button id="confirm">Confirm booking</button></main>';
    const events: Array<{ name: string; detail?: string }> = [];
    sent.mockImplementation((async (type: string) => {
      if (type === 'cdpEvidence') return CDP_REPLY;
      if (type === 'nextAction') return { action: null };
      return undefined;
    }) as unknown as typeof safeSendMessage);

    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames, targets: { take: () => null }, onEvent: (e) => events.push(e) });
    await vi.advanceTimersByTimeAsync(0);

    const ask = sent.mock.calls.find((c) => c[0] === 'nextAction')?.[1] as { evidence?: string };
    expect(ask.evidence).toBe('cdp');
    expect(events.find((e) => e.name === 'evidence')?.detail).toBe('cdp');
    chip.destroy();
  });
});
