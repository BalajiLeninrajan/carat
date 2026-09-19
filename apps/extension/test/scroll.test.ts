import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCROLL_MAX_MS, SCROLL_SETTLE_MS, inViewport, scrollToTarget } from '../src/scroll';

function lay(el: Element, top: number, left = 0, width = 100, height = 30): void {
  el.getBoundingClientRect = () => new DOMRect(left, top, width, height);
}

describe('inViewport', () => {
  it('is true when any part of the box overlaps the viewport, false for a zero-size or off-screen box', () => {
    const el = document.createElement('button');
    lay(el, 100);
    expect(inViewport(el, window)).toBe(true);
    lay(el, window.innerHeight - 1);
    expect(inViewport(el, window)).toBe(true);
    lay(el, window.innerHeight);
    expect(inViewport(el, window)).toBe(false);
    lay(el, -30);
    expect(inViewport(el, window)).toBe(false);
    lay(el, 100, window.innerWidth);
    expect(inViewport(el, window)).toBe(false);
    lay(el, 100, 0, 0, 0);
    expect(inViewport(el, window)).toBe(false);
  });
});

describe('scrollToTarget', () => {
  let el: HTMLElement;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('input');
    document.body.append(el);
    scrollIntoView = vi.fn();
    el.scrollIntoView = scrollIntoView as unknown as typeof el.scrollIntoView;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('centres the element smoothly and settles once scroll events stop', async () => {
    const done = vi.fn();
    void scrollToTarget(el, window).then(done);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    // The page keeps scrolling: each event pushes the settle out again.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS / 2);
      window.dispatchEvent(new Event('scroll'));
    }
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting after the cap, and scrolls at once under prefers-reduced-motion', async () => {
    const done = vi.fn();
    void scrollToTarget(el, window).then(done);
    for (let t = 0; t < SCROLL_MAX_MS; t += SCROLL_SETTLE_MS / 2) {
      await vi.advanceTimersByTimeAsync(SCROLL_SETTLE_MS / 2);
      window.dispatchEvent(new Event('scroll'));
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);

    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    void scrollToTarget(el, window);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center', inline: 'nearest', behavior: 'instant' });
  });
});
