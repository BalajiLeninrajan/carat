import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { QUIET_MS, QUIET_TICK_MS, createQuiet, type Quiet } from '../src/quiet';
import { statusText } from '../src/status';
import type { StatusInfo } from '../src/status/info';

const RUNNING: StatusInfo = { show: true, running: true, model: 'gpt-5', sound: true, acceptKey: 'rightShift' };

describe('the quiet minute Shift+Tab buys', () => {
  let quiet: Quiet;
  let report: Mock<(left: number | null) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    report = vi.fn<(left: number | null) => void>();
    quiet = createQuiet(report);
  });

  afterEach(() => {
    quiet.destroy();
    vi.useRealTimers();
  });

  it('is not running until something starts it', () => {
    expect(quiet.active).toBe(false);
    expect(quiet.left()).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  it('runs for a minute and then lets carat speak again', () => {
    quiet.start();
    expect(quiet.active).toBe(true);
    expect(report).toHaveBeenLastCalledWith(QUIET_MS);

    vi.advanceTimersByTime(QUIET_TICK_MS);
    expect(report).toHaveBeenLastCalledWith(QUIET_MS - QUIET_TICK_MS);

    vi.advanceTimersByTime(QUIET_MS);
    expect(quiet.active).toBe(false);
    expect(report).toHaveBeenLastCalledWith(null);
  });

  it('counts itself down on the status pill', () => {
    quiet.start();
    vi.advanceTimersByTime(QUIET_TICK_MS);
    const left = report.mock.lastCall?.[0] ?? null;
    expect(statusText(RUNNING, false, left)).toBe('carat · quiet 0:59');
  });

  it('ends early when the user asks for a suggestion', () => {
    quiet.start();
    vi.advanceTimersByTime(QUIET_TICK_MS * 5);
    quiet.end();
    expect(quiet.active).toBe(false);
    expect(report).toHaveBeenLastCalledWith(null);

    // And the ticker is gone with it: no further word to the status line.
    const said = report.mock.calls.length;
    vi.advanceTimersByTime(QUIET_MS);
    expect(report.mock.calls.length).toBe(said);
  });

  it('starts the minute over when a second Shift+Tab lands', () => {
    quiet.start();
    vi.advanceTimersByTime(QUIET_MS / 2);
    quiet.start();
    vi.advanceTimersByTime(QUIET_MS / 2 + QUIET_TICK_MS);
    expect(quiet.active).toBe(true);
  });

  it('says nothing more once the page is gone', () => {
    quiet.start();
    quiet.destroy();
    const said = report.mock.calls.length;
    vi.advanceTimersByTime(QUIET_MS);
    expect(report.mock.calls.length).toBe(said);
    expect(quiet.active).toBe(false);
  });
});
