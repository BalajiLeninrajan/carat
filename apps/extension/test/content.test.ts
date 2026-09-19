import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractSuggestion, NavSuggestion, Suggestion } from '@carat/shared';
import { createChip, type Chip, type ChipShowOptions, type CornerShowOptions } from '../src/chip';
import { CAPTURE_TIMING, SNAPSHOT_TIMING, createPageState, startCapture, startSuggestions } from '../src/content';
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
const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};
const escape = () => {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};
type Answer = { suggestions: Suggestion[]; interactions?: Suggestion[]; ticket?: string };
/** Fast answer for the Title field plus a refine ticket whose answer the test releases. */
function fastThenSmart(fast: (ids: Record<string, string>) => Answer) {
  let release!: (v: Answer) => void;
  let ids: Record<string, string> = {};
  sent.mockImplementation((type, data) => {
    if (type === 'suggestRequest') {
      const { fields } = data as { fields: Array<{ i: string; al?: string }> };
      ids = Object.fromEntries(fields.map((f) => [f.al ?? f.i, f.i]));
      return Promise.resolve(fast(ids));
    }
    if (type === 'suggestRefine') return new Promise<Answer>((resolve) => (release = resolve));
    return Promise.resolve(undefined);
  });
  return { ids: () => ids, release: (v: Answer) => release(v) };
}
const s = (fieldId: string, value: string, confidence: number): Suggestion => ({ kind: 'fill', fieldId, value, confidence, reason: '', sourceContextId: 'c1' });
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
    delete (document as { visibilityState?: unknown }).visibilityState;
    vi.useRealTimers();
  });

  it('asks for a picture of a thin page, and for it to be read when the tab hides, but not once a chip has been shown here', async () => {
    const page = createPageState();
    startCapture(ctx, document, { page });
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.initialMs);
    expect(calls('vision')).toEqual([{ action: 'shot', url: location.href, title: document.title, bodyChars: expect.any(Number) }]);
    expect(calls('vision')[0]!.bodyChars as number).toBeLessThan(400);
    // The text capture still happens; the picture is on top of it, not instead of it.
    expect(calls('capture')).toHaveLength(1);

    setVisibility('hidden');
    expect(calls('vision').at(-1)).toMatchObject({ action: 'leaving' });
    expect(calls('vision')).toHaveLength(2);
    setVisibility('visible');

    page.filling = true;
    document.body.append(Object.assign(document.createElement('p'), { textContent: 'New paragraph' }));
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.mutationMs + CAPTURE_TIMING.screenshotMs);
    setVisibility('hidden');
    expect(calls('vision')).toHaveLength(2);
  });

  it('asks for no picture of a text-rich page, and at most one per 15s of a thin one', async () => {
    document.body.innerHTML = `<p>${'Dinner at Seven Shores Cafe, Friday at 6? '.repeat(12)}</p>`;
    startCapture(ctx, document);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.initialMs);
    expect(calls('vision')).toEqual([]);
    expect(calls('capture')).toHaveLength(1);
    ctx.invalidate();

    ctx = fakeCtx();
    document.body.innerHTML = '<p>Dinner at Seven Shores Cafe, Friday at 6? Bring the team.</p>';
    startCapture(ctx, document);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.initialMs);
    document.body.append(Object.assign(document.createElement('p'), { textContent: 'Another line' }));
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.mutationMs);
    expect(calls('capture')).toHaveLength(3);
    expect(calls('vision')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.screenshotMs);
    document.body.append(Object.assign(document.createElement('p'), { textContent: 'And another' }));
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMING.mutationMs);
    expect(calls('vision')).toHaveLength(2);
  });

  it('shows the fast answer at once and swaps in a surer smart value without hiding the chip', async () => {
    const title = field('Title', 100);
    const smart = fastThenSmart((ids) => ({ suggestions: [s(ids.Title!, 'Dinner', 0.8)], ticket: 't1' }));
    const chip = createChip(document);
    const show = vi.spyOn(chip, 'show');
    const hide = vi.spyOn(chip, 'hide');
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();

    expect(chip.visible).toBe(true);
    expect(show.mock.calls.map(([o]) => o.value)).toEqual(['Dinner']);
    // The refine poll goes out only after the fast answer is on screen.
    expect(sent.mock.calls.map(([t]) => t).filter((t) => t.startsWith('suggest'))).toEqual(['suggestRequest', 'suggestRefine']);
    expect(calls('suggestRefine')).toEqual([{ ticket: 't1' }]);

    smart.release({ suggestions: [s(smart.ids().Title!, 'Dinner at Seven Shores Cafe', 0.95)] });
    await flush();
    expect(chip.visible).toBe(true);
    expect(show.mock.calls.map(([o]) => o.value)).toEqual(['Dinner', 'Dinner at Seven Shores Cafe']);
    expect(hide).not.toHaveBeenCalled();

    title.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(title.value).toBe('Dinner at Seven Shores Cafe');
  });

  it('keeps a lower-confidence smart value out, and never moves a visible chip to another field', async () => {
    const title = field('Title', 100);
    field('Location', 200);
    const smart = fastThenSmart((ids) => ({ suggestions: [s(ids.Title!, 'Dinner', 0.8)], ticket: 't1' }));
    const chip = createChip(document);
    const show = vi.spyOn(chip, 'show');
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();

    const ids = smart.ids();
    smart.release({ suggestions: [s(ids.Title!, 'Supper', 0.7), s(ids.Location!, '10 Regina St N', 0.9)] });
    await flush();
    expect(show).toHaveBeenCalledTimes(1);
    expect(chip.visible).toBe(true);

    // The extra field waits its turn: it is the next chip after this fill.
    title.focus();
    tab();
    expect(title.value).toBe('Dinner');
    expect(chip.visible).toBe(true);
    expect(show.mock.calls.at(-1)![0].value).toBe('10 Regina St N');
  });

  it('shows a chip from the smart answer when the fast one had nothing', async () => {
    const title = field('Title', 100);
    const smart = fastThenSmart(() => ({ suggestions: [], ticket: 't1' }));
    const chip = createChip(document);
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(chip.visible).toBe(false);

    smart.release({ suggestions: [s(smart.ids().Title!, 'Dinner', 0.85)] });
    await flush();
    expect(chip.visible).toBe(true);
    title.focus();
    tab();
    expect(title.value).toBe('Dinner');
  });

  it('drops a smart answer for a field the user dismissed', async () => {
    const title = field('Title', 100);
    const smart = fastThenSmart((ids) => ({ suggestions: [s(ids.Title!, 'Dinner', 0.8)], ticket: 't1' }));
    const chip = createChip(document);
    const show = vi.spyOn(chip, 'show');
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    title.focus();
    escape();
    expect(chip.visible).toBe(false);
    expect(calls('feedback')[0]).toMatchObject({ accepted: false });

    smart.release({ suggestions: [s(smart.ids().Title!, 'Dinner at Seven Shores Cafe', 0.99)] });
    await flush();
    expect(chip.visible).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    expect(tab().defaultPrevented).toBe(false);
  });

  it('drops a smart answer that lands after the user typed', async () => {
    const title = field('Title', 100);
    const smart = fastThenSmart((ids) => ({ suggestions: [s(ids.Title!, 'Dinner', 0.8)], ticket: 't1' }));
    const chip = createChip(document);
    const show = vi.spyOn(chip, 'show');
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();

    title.focus();
    title.value = 'Lunch';
    title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'h' }));
    expect(chip.visible).toBe(false);

    smart.release({ suggestions: [s(smart.ids().Title!, 'Dinner at Seven Shores Cafe', 0.99)] });
    await flush();
    expect(chip.visible).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    expect(title.value).toBe('Lunch');
  });

  it('tells the status observer about the fast answer, not the smart one', async () => {
    field('Title', 100);
    const smart = fastThenSmart((ids) => ({ suggestions: [s(ids.Title!, 'Dinner', 0.8)], ticket: 't1' }));
    const onRequest = vi.fn();
    const onAnswer = vi.fn();
    startSuggestions(ctx, createChip(document), document, { onRequest, onAnswer });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    smart.release({ suggestions: [s(smart.ids().Title!, 'Dinner at Seven Shores Cafe', 0.95)] });
    await flush();
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("tells the background this is the page being filled the first time a chip shows here", async () => {
    field('Title', 100);
    const page = createPageState();
    fastThenSmart((ids) => ({ suggestions: [s(ids.Title!, 'Dinner', 0.8)] }));
    startSuggestions(ctx, createChip(document), document, { page });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(page.filling).toBe(true);
    expect(calls('vision')).toEqual([{ action: 'filling', url: location.href, title: document.title, bodyChars: 0 }]);
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
      text: '',
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

  it('does not make the page the one being filled: a source page may still be photographed', async () => {
    const page = createPageState();
    answer(() => [], [nav]);
    startSuggestions(ctx, createChip(document), document, { page });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(page.filling).toBe(false);
    expect(calls('vision')).toEqual([]);
  });

  it('shows the corner chip when there is no field to fill; Tab asks the background to navigate and reports acceptance', async () => {
    const composer = field('Message #general', 100);
    composer.focus();
    answer(() => [], [nav]);
    startSuggestions(ctx, createChip(document), document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    const host = document.querySelector('[data-carat-chip]') as HTMLElement;
    expect(host.style.display).toBe('block');
    expect(host.style.bottom).toBe('24px');

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
      text: '',
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
    expect(host.style.bottom).toBe('24px');
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

describe('interaction chip', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    sent.mockReset();
    sent.mockResolvedValue(undefined);
    ctx = fakeCtx();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    ctx.invalidate();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  type Fields = Array<{ i: string; al?: string; v?: string }>;
  type Elements = Array<{ i: string; nm: string; r: string }>;

  function button(name: string, top: number): HTMLButtonElement {
    const el = document.createElement('button');
    el.textContent = name;
    onScreen(el, top);
    document.body.append(el);
    return el;
  }

  function answer(fn: (fields: Fields, elements: Elements, filledBefore: boolean) => Partial<{ suggestions: Suggestion[]; interactions: InteractSuggestion[] }>) {
    let filled = false;
    sent.mockImplementation(async (type, data) => {
      if (type === 'feedback' && (data as { accepted: boolean; kind?: string }).accepted && !(data as { kind?: string }).kind) filled = true;
      if (type !== 'suggestRequest') return undefined;
      const { fields, elements } = data as { fields: Fields; elements?: Elements };
      return { suggestions: [], navigation: [], interactions: [], ...fn(fields, elements ?? [], filled) };
    });
  }

  it('after the fills, offers the Save button on a fresh answer, takes Tab from the filled field, clicks once and reports it', async () => {
    const title = field('Title', 100);
    const save = button('Save', 200);
    const clicks = vi.fn();
    save.addEventListener('click', clicks);
    answer((fields, elements, filled) => {
      const f = fields.find((x) => x.al === 'Title' && !x.v);
      const e = elements.find((x) => x.nm === 'Save');
      if (f) return { suggestions: [{ kind: 'fill', fieldId: f.i, value: 'Dinner', confidence: 0.9, reason: '', sourceContextId: 'c1' }] };
      if (filled && e) return { interactions: [{ kind: 'interact', elementId: e.i, verb: 'click', value: 'Save', confidence: 0.85, reason: '', sourceContextId: 'c1' }] };
      return {};
    });
    const chip = createChip(document);
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(chip.text).toBe('Fill "Dinner"?');
    expect(calls('suggestRequest')[0]?.elements).toEqual([expect.objectContaining({ i: 'e0', r: 'button', nm: 'Save' })]);

    title.focus();
    tab();
    expect(title.value).toBe('Dinner');
    expect(chip.visible).toBe(false);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs);
    await flush();
    expect(calls('suggestRequest')).toHaveLength(2);
    expect(chip.text).toBe('Click "Save"?');
    expect(document.activeElement).toBe(title);

    const e = tab();
    expect(e.defaultPrevented).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(calls('feedback').at(-1)).toEqual({ kind: 'interact', host: location.host, role: 'button', name: 'Save', accepted: true });
    expect(chip.visible).toBe(false);

    // The same answer comes back from the cache; the button is done for this page load.
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs);
    await flush();
    expect(chip.visible).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('checks a box on Tab, sets a slider with the value in the label, and never re-offers a box already on', async () => {
    document.body.innerHTML = `
      <label><input type="checkbox" id="veg"> Vegetarian</label>
      <label for="vol">Volume</label><input type="range" id="vol" min="0" max="100" value="80">
    `;
    const veg = document.getElementById('veg') as HTMLInputElement;
    const vol = document.getElementById('vol') as HTMLInputElement;
    onScreen(veg, 100);
    onScreen(vol, 200);
    answer((_fields, elements) => ({
      interactions: elements.flatMap((e): InteractSuggestion[] => {
        const base = { kind: 'interact' as const, elementId: e.i, confidence: 0.8, reason: '', sourceContextId: 'c1' };
        if (e.nm === 'Vegetarian') return [{ ...base, verb: 'check', value: 'Vegetarian' }];
        if (e.nm === 'Volume') return [{ ...base, verb: 'set', value: '40' }];
        return [];
      }),
    }));
    const chip = createChip(document);
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(chip.text).toBe('Check "Vegetarian"?');
    tab();
    expect(veg.checked).toBe(true);
    expect(chip.visible).toBe(false);

    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs);
    await flush();
    expect(chip.text).toBe('Set "Volume" to 40?');
    tab();
    expect(vol.value).toBe('40');
    expect(calls('feedback').map((f) => [f.name, f.accepted])).toEqual([
      ['Vegetarian', true],
      ['Volume', true],
    ]);
  });

  it('reports Esc as a dismissal, performs nothing, and drops the offer from the cached answer', async () => {
    const notes = field('Notes', 300);
    const save = button('Save', 100);
    const clicks = vi.fn();
    save.addEventListener('click', clicks);
    answer((_f, elements) => ({
      interactions: elements.map((e) => ({ kind: 'interact' as const, elementId: e.i, verb: 'click' as const, value: 'Save', confidence: 0.85, reason: '', sourceContextId: 'c1' })),
    }));
    const chip = createChip(document);
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(chip.visible).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(clicks).not.toHaveBeenCalled();
    expect(calls('feedback')).toEqual([{ kind: 'interact', host: location.host, role: 'button', name: 'Save', accepted: false }]);

    // Focusing a field re-presents the cached answer, minus the dismissed offer, without asking again.
    notes.focus();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.debounceMs);
    await flush();
    expect(chip.visible).toBe(false);
    expect(calls('suggestRequest')).toHaveLength(1);
  });

  it('prefers a fill over an interaction and an interaction over the corner chip', async () => {
    const title = field('Title', 100);
    button('Save', 200);
    answer((fields, elements) => ({
      suggestions: fields.filter((f) => !f.v).map((f) => ({ kind: 'fill' as const, fieldId: f.i, value: 'Dinner', confidence: 0.9, reason: '', sourceContextId: 'c1' })),
      interactions: elements.map((e) => ({ kind: 'interact' as const, elementId: e.i, verb: 'click' as const, value: 'Save', confidence: 0.85, reason: '', sourceContextId: 'c1' })),
    }));
    sent.mockImplementation(async (type, data) => {
      if (type !== 'suggestRequest') return undefined;
      const { fields, elements } = data as { fields: Fields; elements?: Elements };
      return {
        suggestions: fields.filter((f) => !f.v).map((f) => ({ kind: 'fill', fieldId: f.i, value: 'Dinner', confidence: 0.9, reason: '', sourceContextId: 'c1' })),
        interactions: (elements ?? []).map((e) => ({ kind: 'interact', elementId: e.i, verb: 'click', value: 'Save', confidence: 0.85, reason: '', sourceContextId: 'c1' })),
        navigation: [nav],
      };
    });
    const chip = createChip(document);
    startSuggestions(ctx, chip, document);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMING.initialMs);
    await flush();
    expect(chip.text).toBe('Fill "Dinner"?');
    title.focus();
    tab();
    // The fill exhausted; the same answer's interaction takes the chip, not the corner.
    expect(chip.text).toBe('Click "Save"?');
    expect((document.querySelector('[data-carat-chip]') as HTMLElement).style.bottom).toBe('');
    expect(calls('navigate')).toEqual([]);
  });
});
