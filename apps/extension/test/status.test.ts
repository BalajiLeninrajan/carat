import { DEFAULT_SETTINGS } from '@carat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeStatus } from '../src/background/status';
import { createStatusLine, statusText } from '../src/status';
import { startStatus, STATUS_TIMING } from '../src/content';
import type { ScriptContext } from '../src/content';

const sent = vi.hoisted(() => vi.fn<(type: string, data: unknown) => Promise<unknown>>());
vi.mock('../src/messaging', () => ({ safeSendMessage: sent }));

const settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-x', statusLine: true };

describe('describeStatus', () => {
  it('reports the configured model when a key is set and the page is allowed', () => {
    const s = describeStatus(settings, 'https://maps.google.com/');
    expect(s).toEqual({ show: true, running: true, sound: true, provider: 'openai', model: 'gpt-5.6-luna' });
  });

  it('reports local when there is no key or the provider is local, whatever the model field says', () => {
    expect(describeStatus({ ...settings, apiKey: '' }, 'https://a.test/').model).toBe('local');
    expect(describeStatus({ ...settings, provider: 'local' }, 'https://a.test/').provider).toBe('local');
  });


  it('explains why it is not running, in priority order', () => {
    expect(describeStatus({ ...settings, enabled: false }, 'https://a.test/')).toMatchObject({
      running: false,
      reason: 'disabled',
    });
    expect(describeStatus(settings, 'chrome://extensions').reason).toBe('not-http');
    expect(describeStatus(settings, undefined).reason).toBe('not-http');
    expect(describeStatus(settings, 'https://accounts.google.com/signin').reason).toBe('denylisted');
    expect(describeStatus({ ...settings, disabledHosts: ['a.test'] }, 'https://a.test/x').reason).toBe(
      'site-off',
    );
  });

  it('never includes the key', () => {
    expect(JSON.stringify(describeStatus(settings, 'https://a.test/'))).not.toContain('sk-x');
  });

  it('follows the statusLine setting for show', () => {
    expect(describeStatus({ ...settings, statusLine: false }, 'https://a.test/').show).toBe(false);
  });
});

describe('statusText', () => {
  it('names the model while running and the reason while not', () => {
    expect(statusText({ show: true, running: true, sound: true, provider: 'openai', model: 'gpt-5.6-luna' })).toBe(
      'carat · gpt-5.6-luna',
    );
    expect(statusText({ show: true, running: true, sound: true, provider: 'openai', model: 'gpt-5.6-luna' }, true)).toBe(
      'carat · gpt-5.6-luna · thinking',
    );
    expect(statusText({ show: true, running: true, sound: true, provider: 'local', model: 'local' })).toBe('carat · local');
    expect(statusText({ show: true, running: false, sound: true, reason: 'site-off', provider: 'openai', model: 'x' })).toBe(
      'carat · off for this site',
    );
  });

  it('counts a snooze down instead of naming the model', () => {
    const running = { show: true, running: true, sound: true, provider: 'openai' as const, model: 'gpt-5.6-luna' };
    expect(statusText(running, false, 42_000)).toBe('carat · quiet 0:42');
    expect(statusText(running, false, 60_000)).toBe('carat · quiet 1:00');
    // A request cannot be in flight during a snooze, and the countdown says so first anyway.
    expect(statusText(running, true, 600)).toBe('carat · quiet 0:01');
    // Off is off, whatever the snooze says.
    expect(statusText({ ...running, running: false, reason: 'disabled' }, false, 42_000)).toBe('carat · off');
  });
});

describe('status line element', () => {
  afterEach(() => {
    document.querySelectorAll('[data-carat-status]').forEach((el) => el.remove());
  });

  it('stays out of the document until shown, and hides again when the setting is off', () => {
    const line = createStatusLine(document);
    expect(document.querySelector('[data-carat-status]')).toBeNull();
    line.update({ show: true, running: true, sound: true, provider: 'openai', model: 'm' });
    const host = document.querySelector<HTMLElement>('[data-carat-status]');
    expect(host).not.toBeNull();
    expect(host!.style.display).toBe('block');
    expect(host!.style.pointerEvents).toBe('none');
    // Bottom-left: the tab-offer banner owns the bottom centre and the chip may sit anywhere else.
    expect(host!.style.left).toBe('12px');
    expect(host!.style.right).toBe('');
    expect(host!.style.bottom).toBe('12px');
    expect(line.visible).toBe(true);
    line.update({ show: false, running: true, sound: true, provider: 'openai', model: 'm' });
    expect(host!.style.display).toBe('none');
    expect(line.visible).toBe(false);
  });

  it('removes itself on destroy', () => {
    const line = createStatusLine(document);
    line.update({ show: true, running: true, sound: true, provider: 'openai', model: 'm' });
    line.destroy();
    expect(document.querySelector('[data-carat-status]')).toBeNull();
  });
});

describe('status poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sent.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeCtx(): ScriptContext & { invalidate(): void } {
    const onInvalid: Array<() => void> = [];
    const ctx = {
      isValid: true,
      setTimeout: (fn: () => void, ms?: number) => window.setTimeout(fn, ms),
      addEventListener(target: EventTarget, type: string, handler: EventListener) {
        target.addEventListener(type, handler);
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

  it('asks the background on start, on the poll interval, and after an answer, and only ever asks getStatus', async () => {
    const info = { show: true, running: true, sound: true, provider: 'openai', model: 'm' };
    sent.mockResolvedValue(info);
    const updates: unknown[] = [];
    const line = {
      update: (i: unknown) => updates.push(i),
      setBusy: vi.fn(),
      setQuiet: vi.fn(),
      destroy: vi.fn(),
      visible: false,
    };
    const ctx = fakeCtx();
    const handle = startStatus(ctx, line, document);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveBeenCalledWith('getStatus', undefined);
    expect(updates).toEqual([info]);

    await vi.advanceTimersByTimeAsync(STATUS_TIMING.pollMs);
    expect(updates.length).toBe(2);

    handle.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.length).toBe(3);
    expect(sent.mock.calls.every(([type]) => type === 'getStatus')).toBe(true);

    handle.setBusy(true);
    expect(line.setBusy).toHaveBeenCalledWith(true);

    ctx.invalidate();
    expect(line.destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.pollMs);
    expect(updates.length).toBe(3);
  });

  it('ticks the snooze down every second and stops when the minute is up', async () => {
    sent.mockResolvedValue({ show: true, running: true, sound: true, provider: 'openai', model: 'm' });
    const setQuiet = vi.fn();
    const line = { update: vi.fn(), setBusy: vi.fn(), setQuiet, destroy: vi.fn(), visible: false };
    const handle = startStatus(fakeCtx(), line, document);

    handle.setQuiet(Date.now() + 3000);
    expect(setQuiet).toHaveBeenLastCalledWith(3000);
    await vi.advanceTimersByTimeAsync(STATUS_TIMING.quietTickMs);
    expect(setQuiet).toHaveBeenLastCalledWith(2000);
    await vi.advanceTimersByTimeAsync(2 * STATUS_TIMING.quietTickMs);
    expect(setQuiet).toHaveBeenLastCalledWith(null);
    const ticks = setQuiet.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * STATUS_TIMING.quietTickMs);
    expect(setQuiet.mock.calls.length).toBe(ticks);

    // Ended early by the shortcut: the pill goes back to the model on the spot.
    handle.setQuiet(Date.now() + 60_000);
    handle.setQuiet(null);
    expect(setQuiet).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(2 * STATUS_TIMING.quietTickMs);
    expect(setQuiet).toHaveBeenLastCalledWith(null);
  });

  it('drops an answer that arrives after the script was invalidated', async () => {
    let resolve!: (v: unknown) => void;
    sent.mockReturnValue(new Promise((r) => (resolve = r)));
    const line = { update: vi.fn(), setBusy: vi.fn(), setQuiet: vi.fn(), destroy: vi.fn(), visible: false };
    const ctx = fakeCtx();
    startStatus(ctx, line, document);
    ctx.invalidate();
    resolve({ show: true, running: true, sound: true, provider: 'openai', model: 'm' });
    await vi.advanceTimersByTimeAsync(0);
    expect(line.update).not.toHaveBeenCalled();
  });
});
