import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextAction } from '@carat/shared';
import { createChip } from '../src/chip';
import type { ScriptContext } from '../src/content';
import { SNAPSHOT_TIMING, startActions } from '../src/content/action-scheduler';
import type { FrameHub } from '../src/frames';
import { safeSendMessage } from '../src/messaging';

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

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

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
    await tick(SNAPSHOT_TIMING.initialMs);

    const asked = sent.mock.calls.filter((c) => c[0] === 'nextAction');
    expect(asked).toHaveLength(1);
    const request = asked[0]![1] as { controls: Array<{ name: string }>; outline: string };
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
    await tick(SNAPSHOT_TIMING.initialMs);
    expect(chip.text).toBe('Scroll down');
    const host = document.querySelector('[data-carat-chip]') as HTMLElement;
    expect(host.style.left).toBe('50%');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
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
    await tick(SNAPSHOT_TIMING.initialMs);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
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
    await tick(SNAPSHOT_TIMING.initialMs);
    expect([chip.visible, chip.text]).toEqual([true, 'Click "Save"']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await tick(0);
    expect(clicks).toHaveBeenCalledTimes(1);
    const feedback = sent.mock.calls.find((c) => c[0] === 'feedback')![1] as { accepted: boolean; kind: string };
    expect(feedback).toMatchObject({ accepted: true, kind: 'click' });
    chip.destroy();
  });

  it('tells the background nothing was wanted when Esc lands, and does not offer it again', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answer(action({ target: 1 }));
    const chip = createChip(document);
    const handle = startActions(fakeCtx(), chip, document, { hub: noFrames });
    await tick(SNAPSHOT_TIMING.initialMs);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(chip.visible).toBe(false);
    const feedback = sent.mock.calls.find((c) => c[0] === 'feedback')![1] as { accepted: boolean };
    expect(feedback.accepted).toBe(false);

    handle.refresh();
    await tick(SNAPSHOT_TIMING.debounceMs);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });

  it('shows nothing at all when the background has nothing', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    layAll();
    answer(null);
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames });
    await tick(SNAPSHOT_TIMING.initialMs);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });
});
