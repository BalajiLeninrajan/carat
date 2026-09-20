import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextAction } from '@carat/shared';
import { createChip } from '../src/chip';
import type { ScriptContext } from '../src/content';
import { SNAPSHOT_TIMING, startActions } from '../src/content/action-scheduler';
import type { FrameHub } from '../src/frames';
import type { GhostHandle } from '../src/ghost';
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

const action: NextAction = {
  kind: 'click',
  target: 1,
  value: '',
  label: 'Click "Save"',
  irreversible: false,
  confidence: 0.8,
  reason: '',
};

/** A ghost the test switches on and off, recording what the scheduler tells it. */
function fakeGhost(): GhostHandle & { showing: boolean; told: string[]; outline: string } {
  const told: string[] = [];
  return {
    showing: false,
    told,
    outline: '',
    get visible() {
      return this.showing;
    },
    field: null,
    text: '',
    typed(this: { told: string[] }) {
      this.told.push('typed');
    },
    focused(this: { told: string[] }) {
      this.told.push('focused');
    },
    noteOutline(this: { outline: string }, next: string) {
      this.outline = next;
    },
    drop: () => undefined,
    destroy: () => undefined,
  } as GhostHandle & { showing: boolean; told: string[]; outline: string };
}

function layAll(): void {
  for (const el of document.querySelectorAll('input,button,a,select')) {
    el.getBoundingClientRect = () => ({ top: 100, left: 20, bottom: 130, right: 220, width: 200, height: 30 }) as DOMRect;
  }
}

const asks = (): unknown[] => sent.mock.calls.filter((c) => c[0] === 'nextAction').map((c) => c[1]);
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  sent.mockReset();
  sent.mockImplementation((async (type: string) => (type === 'nextAction' ? { action } : undefined)) as unknown as typeof safeSendMessage);
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const ctx of live.splice(0)) ctx.invalidate();
  vi.useRealTimers();
});

describe('who owns Tab', () => {
  it('asks for nothing while grey text is on screen, and asks again once it has gone', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    const ghost = fakeGhost();
    ghost.showing = true;
    const chip = createChip(document);
    const actions = startActions(fakeCtx(), chip, document, { hub: noFrames, ghost });

    await tick(0);
    await tick(SNAPSHOT_TIMING.settleMs + SNAPSHOT_TIMING.minGapMs);
    expect(asks()).toHaveLength(0);
    expect(chip.visible).toBe(false);

    ghost.showing = false;
    actions.refresh();
    await tick(SNAPSHOT_TIMING.mutationQuietMs + SNAPSHOT_TIMING.minGapMs);
    expect(asks()).toHaveLength(1);
    expect(chip.visible).toBe(true);
    chip.destroy();
  });

  it('keeps the chip off the page when a ghost goes up while an answer is in flight', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    const ghost = fakeGhost();
    const chip = createChip(document);
    sent.mockImplementation((async (type: string) => {
      if (type !== 'nextAction') return undefined;
      // The pause landed while the background was thinking.
      ghost.showing = true;
      return { action };
    }) as unknown as typeof safeSendMessage);
    startActions(fakeCtx(), chip, document, { hub: noFrames, ghost });
    await tick(0);
    expect(asks()).toHaveLength(1);
    expect(chip.visible).toBe(false);
    chip.destroy();
  });

  it('the shortcut still gets through, because the user asked for it by hand', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    const ghost = fakeGhost();
    ghost.showing = true;
    const chip = createChip(document);
    const actions = startActions(fakeCtx(), chip, document, { hub: noFrames, ghost });
    await tick(0);
    expect(asks()).toHaveLength(0);
    actions.force();
    await tick(0);
    expect(asks()).toHaveLength(1);
    chip.destroy();
  });

  it('hands the ghost the news: typing, the focus moving, and the outline it just built', async () => {
    document.body.innerHTML = '<main><input aria-label="Title"><button>Save</button></main>';
    layAll();
    const ghost = fakeGhost();
    const chip = createChip(document);
    startActions(fakeCtx(), chip, document, { hub: noFrames, ghost });
    await tick(0);
    expect(ghost.outline).toContain('Title');

    const field = document.querySelector('input')!;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(ghost.told).toEqual(['typed', 'focused']);
    chip.destroy();
  });
});
