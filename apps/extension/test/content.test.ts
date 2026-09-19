import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Suggestion } from '@carat/shared';
import { createChip } from '../src/chip';
import { CAPTURE_TIMING, SNAPSHOT_TIMING, startCapture, startSuggestions } from '../src/content';
import type { ScriptContext } from '../src/content';

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
        .map((f) => ({ fieldId: f.i, value: 'Dinner', confidence: 0.9, reason: '', sourceContextId: 'c1' }));
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
        .map((f) => ({ fieldId: f.i, value: values[f.al!]!, confidence: 0.9, reason: '', sourceContextId: 'c1' }));
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
