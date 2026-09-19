import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavSuggestion, Suggestion } from '@carat/shared';
import { createChip, type Chip, type ChipShowOptions, type CornerShowOptions } from '../src/chip';
import { CAPTURE_TIMING, SNAPSHOT_TIMING, startCapture, startSuggestions } from '../src/content';
import type { ScriptContext } from '../src/content';
import type { NavigationView } from '../src/messaging';

const sent = vi.hoisted(() => vi.fn<(type: string, data: unknown) => Promise<unknown>>());
vi.mock('../src/messaging', () => ({ safeSendMessage: sent }));

// Listeners on the real ContentScriptContext depend on the fake browser's runtime id; this
// keeps the tests about carat's wiring rather than WXT's.
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

function onScreen(el: Element, top: number): void {
  el.getBoundingClientRect = () =>
    ({ top, left: 20, bottom: top + 30, right: 320, width: 300, height: 30 }) as DOMRect;
}

function field(label: string, top: number): HTMLInputElement {
  const el = document.createElement('input');
  el.setAttribute('aria-label', label);
  onScreen(el, top);
  document.body.append(el);
  return el;
}

function tab(): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const calls = (type: string) => sent.mock.calls.filter(([t]) => t === type).map(([, d]) => d as Record<string, unknown>);

describe('content wiring', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    sent.mockReset();
    sent.mockResolvedValue(undefined);
    ctx = fakeCtx();
    document.body.innerHTML = `<p>${'Dinner at Seven Shores Cafe, Friday at 6? '.repeat(3)}</p>`;
  });

  afterEach(() => {
    ctx.invalidate();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('captures the page once after the initial delay and again only when the text changes', async () => {
    startCapture(ctx, document);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.initialMs);
    expect(calls('capture')).toHaveLength(1);
    expect(calls('capture')[0]).toMatchObject({ kind: 'page', url: location.href });
    expect(calls('capture')[0]?.text).toContain('Seven Shores Cafe');

    document.body.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.mutationMs);
    expect(calls('capture')).toHaveLength(1);

    document.body.append(Object.assign(document.createElement('p'), { textContent: 'New paragraph' }));
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.mutationMs);
    expect(calls('capture')).toHaveLength(2);
  });

  it('shows a chip for the suggested field, fills on Tab, and reports acceptance', async () => {
    const title = field('Title', 100);
    sent.mockImplementation(async (type, data) => {
      if (type !== 'suggestRequest') return undefined;
      const { fields } = data as { fields: Array<{ i: string; al?: string; v?: string }> };
      const suggestions: Suggestion[] = fields
        .filter((f) => !f.v && f.al === 'Title')
        .map((f) => ({ kind: 'fill' as const, fieldId: f.i, value: 'Dinner', confidence: 0.9, reason: '', sourceContextId: 'c1' }));
      return { suggestions };
    });
    startSuggestions(ctx, createChip(document), document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(calls('suggestRequest')).toHaveLength(1);
    const chipHost = document.querySelector('[data-carat-chip]') as HTMLElement;
    expect(chipHost.style.display).toBe('block');

    title.focus();
    const e = tab();
    expect(e.defaultPrevented).toBe(true);
    expect(title.value).toBe('Dinner');
    expect(calls('feedback')[0]).toMatchObject({ accepted: true, contextId: 'c1', host: location.host });
  });

  it('shows the next chip from the same answer right after a fill and takes Tab from the filled field', async () => {
    const title = field('Title', 100);
    const where = field('Location', 200);
    const values: Record<string, string> = { Title: 'Dinner', Location: '123 King St' };
    const providerMs = 2000;
    sent.mockImplementation(async (type, data) => {
      if (type !== 'suggestRequest') return undefined;
      const { fields } = data as { fields: Array<{ i: string; al?: string; v?: string }> };
      const suggestions: Suggestion[] = fields
        .filter((f) => !f.v && f.al && values[f.al])
        .map((f) => ({ kind: 'fill' as const, fieldId: f.i, value: values[f.al!]!, confidence: 0.9, reason: '', sourceContextId: 'c1' }));
      await new Promise((resolve) => setTimeout(resolve, providerMs));
      return { suggestions };
    });
    title.focus();
    const chip = createChip(document);
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs + providerMs);
    await flush();
    expect(calls('suggestRequest')).toHaveLength(1);

    tab();
    expect(title.value).toBe('Dinner');
    expect(chip.visible).toBe(true);
    expect(document.activeElement).toBe(title);

    // Well inside the debounce window, long before a second round trip could land.
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs / 2);
    const e = tab();
    expect(e.defaultPrevented).toBe(true);
    expect(where.value).toBe('123 King St');
    expect(calls('feedback')).toHaveLength(2);

    // Only the fill that exhausted the answer asks the provider again.
    expect(calls('suggestRequest')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs + providerMs);
    await flush();
    expect(calls('suggestRequest')).toHaveLength(2);
  });

  it('never fills over text the user typed while the request was in flight', async () => {
    const search = field('Search', 100);
    search.focus();
    let answer!: () => void;
    sent.mockImplementation((type, data) => {
      if (type !== 'suggestRequest') return Promise.resolve(undefined);
      const { fields } = data as { fields: Array<{ i: string }> };
      return new Promise((resolve) => {
        answer = () =>
          resolve({
            suggestions: [
              { fieldId: fields[0]!.i, value: 'Seven Shores Cafe', confidence: 0.9, reason: '', sourceContextId: 'c1' },
            ],
          });
      });
    });
    startSuggestions(ctx, createChip(document), document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    expect(calls('suggestRequest')).toHaveLength(1);

    search.value = 'pizza near me';
    search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'e' }));
    answer();
    await flush();
    const chipHost = document.querySelector('[data-carat-chip]') as HTMLElement | null;
    expect(chipHost?.style.display ?? 'none').toBe('none');
    expect(tab().defaultPrevented).toBe(false);
    expect(search.value).toBe('pizza near me');
  });

  it('refuses to fill on Tab when the field is no longer empty', async () => {
    const search = field('Search', 100);
    sent.mockImplementation(async (type, data) => {
      if (type !== 'suggestRequest') return undefined;
      const { fields } = data as { fields: Array<{ i: string }> };
      return {
        suggestions: [
          { fieldId: fields[0]!.i, value: 'Seven Shores Cafe', confidence: 0.9, reason: '', sourceContextId: 'c1' },
        ],
      };
    });
    startSuggestions(ctx, createChip(document), document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect((document.querySelector('[data-carat-chip]') as HTMLElement).style.display).toBe('block');

    // A write that fires no `input` (the site's own autocomplete) still counts as the user's.
    search.value = 'pizza near me';
    search.focus();
    tab();
    expect(search.value).toBe('pizza near me');
    expect(calls('feedback')).toHaveLength(0);
  });

  it('force asks again at once with force set, past the identical-snapshot memo', async () => {
    field('Title', 100);
    sent.mockImplementation(async (type) => (type === 'suggestRequest' ? { suggestions: [] } : undefined));
    const handle = startSuggestions(ctx, createChip(document), document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(calls('suggestRequest')).toHaveLength(1);
    expect(calls('suggestRequest')[0]).not.toHaveProperty('force');

    // Same fields inside the memo window: an ordinary trigger is answered locally.
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs);
    await flush();
    expect(calls('suggestRequest')).toHaveLength(1);

    handle.force();
    await flush();
    expect(calls('suggestRequest')).toHaveLength(2);
    expect(calls('suggestRequest')[1]).toMatchObject({ force: true });
  });

  it('tells the chip where the value came from and why', async () => {
    field('Title', 100);
    const twoMinutesAgo = Date.now() - 2 * 60_000;
    sent.mockImplementation(async (type, data) => {
      if (type !== 'suggestRequest') return undefined;
      const { fields } = data as { fields: Array<{ i: string }> };
      return {
        suggestions: [
          {
            fieldId: fields[0]!.i,
            value: 'Dinner',
            confidence: 0.9,
            reason: 'Discord message names a plan',
            sourceContextId: 'c1',
            source: { host: 'discord.com', capturedAt: twoMinutesAgo },
          },
        ],
      };
    });
    const shows: ChipShowOptions[] = [];
    const chip: Chip = {
      show: (opts) => void shows.push(opts),
      showCorner: () => undefined,
      hide: () => undefined,
      destroy: () => undefined,
      visible: false,
    };
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(shows[0]).toMatchObject({
      value: 'Dinner',
      detail: 'from discord.com · 2m ago',
      reason: 'Discord message names a plan',
    });
  });

  it('lets Tab through when an unrelated text field has focus', async () => {
    field('Title', 100);
    const notes = field('Notes', 200);
    sent.mockImplementation(async (type, data) => {
      if (type !== 'suggestRequest') return undefined;
      const { fields } = data as { fields: Array<{ i: string; al?: string }> };
      const f = fields.find((x) => x.al === 'Title')!;
      return { suggestions: [{ fieldId: f.i, value: 'Dinner', confidence: 0.9, reason: '', sourceContextId: 'c1' }] };
    });
    startSuggestions(ctx, createChip(document), document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    notes.focus();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs);
    await flush();
    expect(tab().defaultPrevented).toBe(false);
  });
});

const nav: NavSuggestion = {
  kind: 'open',
  intent: 'maps',
  label: 'Open in Google Maps',
  value: 'Seven Shores Cafe',
  when: '',
  location: '',
  url: 'https://www.google.com/maps/search/?api=1&query=Seven+Shores+Cafe',
  confidence: 0.9,
  reason: '',
  sourceContextId: 'o1',
};

describe('navigation chip', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    sent.mockReset();
    sent.mockResolvedValue(undefined);
    ctx = fakeCtx();
    document.body.innerHTML = `<p>${'dinner at Seven Shores Cafe, Friday at 6? '.repeat(3)}</p>`;
  });

  afterEach(() => {
    ctx.invalidate();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  function answer(fills: (fields: Array<{ i: string; al?: string }>) => Suggestion[], navigation: NavigationView[]) {
    sent.mockImplementation(async (type, data) => {
      if (type !== 'suggestRequest') return undefined;
      const { fields } = data as { fields: Array<{ i: string; al?: string }> };
      return { suggestions: fills(fields), navigation };
    });
  }

  it('shows the corner chip when there is no field to fill; Tab asks the background to navigate and reports acceptance', async () => {
    const composer = field('Message #general', 100);
    composer.focus();
    answer(() => [], [nav]);
    startSuggestions(ctx, createChip(document), document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    const host = document.querySelector('[data-carat-chip]') as HTMLElement;
    expect(host.style.display).toBe('block');
    expect(host.style.bottom).toBe('16px');

    const e = tab();
    expect(e.defaultPrevented).toBe(true);
    expect(composer.value).toBe('');
    expect(calls('navigate')).toEqual([nav]);
    expect(calls('feedback')).toEqual([{ kind: 'nav', intent: 'maps', value: 'Seven Shores Cafe', accepted: true }]);
    expect(host.style.display).toBe('none');
  });

  it('tells the corner chip the offer came from this page, and why', async () => {
    field('Message #general', 100);
    const twoMinutesAgo = Date.now() - 2 * 60_000;
    answer(() => [], [{ ...nav, reason: 'a place to meet', source: { host: document.location.host, capturedAt: twoMinutesAgo } }]);
    const shows: CornerShowOptions[] = [];
    const chip: Chip = {
      show: () => undefined,
      showCorner: (opts) => void shows.push(opts),
      hide: () => undefined,
      destroy: () => undefined,
      visible: false,
    };
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(shows[0]).toMatchObject({
      label: 'Open in Google Maps',
      value: 'Seven Shores Cafe',
      detail: 'from this page · 2m ago',
      reason: 'a place to meet',
    });
  });

  it('prefers a field chip over the corner chip when the answer has both', async () => {
    const title = field('Title', 100);
    answer(
      (fields) => fields.filter((f) => f.al === 'Title').map((f) => ({ kind: 'fill' as const, fieldId: f.i, value: 'Dinner', confidence: 0.9, reason: '', sourceContextId: 'c1' })),
      [nav],
    );
    startSuggestions(ctx, createChip(document), document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    const host = document.querySelector('[data-carat-chip]') as HTMLElement;
    expect(host.style.bottom).toBe('');
    title.focus();
    tab();
    expect(title.value).toBe('Dinner');
    expect(calls('navigate')).toEqual([]);
    // With the fill consumed, the same answer's navigation takes the corner.
    expect(host.style.display).toBe('block');
    expect(host.style.bottom).toBe('16px');
  });

  it('reports a dismissal on Escape and never navigates', async () => {
    field('Message #general', 100);
    answer(() => [], [nav]);
    startSuggestions(ctx, createChip(document), document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(calls('navigate')).toEqual([]);
    expect(calls('feedback')).toEqual([{ kind: 'nav', intent: 'maps', value: 'Seven Shores Cafe', accepted: false }]);
    // Focusing the composer again re-presents the cached answer, minus the dismissed offer.
    (document.querySelector('input') as HTMLInputElement).focus();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs);
    await flush();
    expect((document.querySelector('[data-carat-chip]') as HTMLElement).style.display).toBe('none');
    expect(calls('suggestRequest')).toHaveLength(1);
  });

  it('asks again after the page\'s own text is captured, but not while a chip is up', async () => {
    field('Message #general', 100);
    answer(() => [], []);
    const handle = startSuggestions(ctx, createChip(document), document);
    startCapture(ctx, document, { onCaptured: () => handle.refresh() });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(calls('suggestRequest')).toHaveLength(1);

    answer(() => [], [nav]);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.initialMs - SNAPSHOT_TIMING.initialMs + SNAPSHOT_TIMING.debounceMs);
    await flush();
    expect(calls('capture')).toHaveLength(1);
    expect(calls('suggestRequest')).toHaveLength(2);
    expect((document.querySelector('[data-carat-chip]') as HTMLElement).style.display).toBe('block');

    handle.refresh();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs);
    await flush();
    expect(calls('suggestRequest')).toHaveLength(2);
  });
});
