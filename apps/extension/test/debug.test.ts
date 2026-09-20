import { DEFAULT_SETTINGS } from '@carat/shared';
import type { NextAction, NextActionRequest, Settings } from '@carat/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextOptions, Provider } from '@carat/providers';
import { createChip } from '../src/chip';
import { clearActionCache, nextAction } from '../src/background/orchestrate';
import {
  DEBUG_COMMAND,
  DEBUG_LIMITS,
  DebugLog,
  debugSnapshot,
  handleDebugCommand,
} from '../src/background/debug';
import type { DebugSnapshot, TabDiag } from '../src/background';
import { createDebugPanel, debugView } from '../src/debug';
import type { DebugPanel } from '../src/debug';
import { clearSurfaces } from '../src/dom/surfaces';
import type { HistoryEntry } from '../src/history';
import type { StorageArea } from '../src/store';

function area(): StorageArea {
  const data: Record<string, unknown> = {};
  return {
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (items) => void Object.assign(data, items),
    remove: async (keys) => void keys.forEach((k) => delete data[k]),
  };
}

const action = (over: Partial<NextAction> = {}): NextAction => ({
  kind: 'click',
  target: 3,
  value: '',
  label: 'Click "Continue to payment"',
  irreversible: true,
  confidence: 0.82,
  reason: 'the cart is filled in and this is the primary control',
  ...over,
});

const request = (over: Partial<NextActionRequest> = {}): NextActionRequest => ({
  page: { host: 'shop.test', title: 'Cart', path: '/cart', scroll: { y: 0.4, pages: 2.2, more: true } },
  outline: 'main:\n  Cart\n  [3] button "Continue to payment"\n  [4] link "Keep shopping"',
  controls: [
    { n: 3, role: 'button', name: 'Continue to payment' },
    { n: 4, role: 'link', name: 'Keep shopping' },
  ],
  focused: 3,
  history: ['40s ago: clicked button "Add to cart"'],
  notes: ['Dinner at Seven Shores Cafe on Friday at 18:00 (read on discord.com, 2m ago)'],
  tabs: [{ id: 9, host: 'discord.com', title: 'Discord' }],
  now: '2026-09-19T18:00:00.000-04:00',
  eagerness: 'eager',
  ...over,
});

const diag = (): TabDiag => ({
  suggest: {
    at: 1000,
    host: 'shop.test',
    controls: 2,
    gate: 'ok',
    source: 'model',
    ms: 820,
    placeholderMs: 4,
    partialMs: 310,
    finalMs: 790,
    warmed: true,
    eagerness: 'eager',
    kind: 'click',
    label: 'Click "Continue to payment"',
    reason: 'the cart is filled in and this is the primary control',
    confidence: 0.82,
    irreversible: true,
    attempts: [{ id: 'openai', ms: 780, kind: 'click' }],
  },
});

function snapshot(over: Partial<DebugSnapshot> = {}): DebugSnapshot {
  const history: HistoryEntry[] = [{ t: 500, kind: 'click', role: 'button', name: 'Add to cart' }];
  return {
    at: 2000,
    tabId: 7,
    on: true,
    diag: diag(),
    debug: {
      on: true,
      request: { at: 900, req: request(), cacheKey: 'shop.test|/cart|abc|1|eager', promptCacheKey: 'carat-9xyz' },
      answer: {
        at: 1800,
        placeholder: null,
        action: action(),
        raw: '{"target":3,"kind":"click","label":"Continue to payment"}',
        winner: 'openai',
        attempts: [{ id: 'openai', ms: 780, kind: 'click' }],
        validations: ['placeholder: nothing to allow', 'model: allowed'],
      },
      events: [{ at: 1200, source: 'engine', name: 'warmed', detail: 'prefix already cached' }],
    },
    history,
    gate: {
      verdict: 'ok',
      host: 'shop.test',
      enabled: true,
      siteOn: true,
      denylisted: false,
      password: false,
      snapshot: true,
    },
    ...over,
  };
}

const extras = { events: [], hidden: false, snoozedUntil: null, now: 2000 };

describe('the toggleDebug command', () => {
  it('toggles the panel on the tab it fired over, and nothing else', () => {
    const toggle = vi.fn<(tabId: number) => void>();
    expect(handleDebugCommand(DEBUG_COMMAND, 7, { toggle })).toBe(true);
    expect(toggle).toHaveBeenCalledWith(7);
    expect(handleDebugCommand('carat-suggest', 7, { toggle })).toBe(false);
    expect(handleDebugCommand(DEBUG_COMMAND, undefined, { toggle })).toBe(false);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('opens the panel and closes it again', () => {
    const panel = createDebugPanel();
    expect(panel.visible).toBe(false);
    expect(panel.toggle()).toBe(true);
    expect(panel.visible).toBe(true);
    expect(panel.toggle()).toBe(false);
    expect(panel.visible).toBe(false);
    panel.destroy();
  });
});

describe('DebugLog', () => {
  it('keeps nothing until the panel opens, and drops it all again when it closes', async () => {
    const log = new DebugLog(area());
    expect(await log.isOn(7)).toBe(false);
    await log.recordEvent(7, { at: 1, source: 'engine', name: 'ignored' });
    expect(await log.get(7)).toBeNull();

    await log.open(7);
    expect(await log.isOn(7)).toBe(true);
    await log.recordEvent(7, { at: 2, source: 'engine', name: 'kept' });
    expect((await log.get(7))?.events).toHaveLength(1);

    await log.close(7);
    expect(await log.isOn(7)).toBe(false);
    expect(await log.get(7)).toBeNull();
  });

  it('holds the last fifty events and trims a long outline and a long reply', async () => {
    const log = new DebugLog(area());
    await log.open(7);
    for (let i = 0; i < DEBUG_LIMITS.events + 10; i++) await log.recordEvent(7, { at: i, source: 'page', name: `e${i}` });
    const events = (await log.get(7))?.events ?? [];
    expect(events).toHaveLength(DEBUG_LIMITS.events);
    expect(events[0]?.name).toBe('e10');

    await log.recordRequest(7, {
      at: 1,
      req: request({ outline: 'x'.repeat(DEBUG_LIMITS.outlineChars + 500) }),
      cacheKey: 'k',
      promptCacheKey: 'p',
    });
    await log.recordAnswer(7, { at: 2, placeholder: null, action: null, raw: 'y'.repeat(DEBUG_LIMITS.rawChars + 500), attempts: [], validations: [] });
    const held = await log.get(7);
    expect(held?.request?.req.outline).toHaveLength(DEBUG_LIMITS.outlineChars);
    expect(held?.answer?.raw).toHaveLength(DEBUG_LIMITS.rawChars);
  });
});

describe('getDebug', () => {
  const sources = (settings: Partial<Settings> = {}, log = new DebugLog(area())) => ({
    log,
    src: {
      diag: { get: async () => diag() },
      debug: log,
      history: { entries: async () => [{ t: 500, kind: 'click', role: 'button', name: 'Add to cart' }] as HistoryEntry[] },
      settings: async () => ({ ...DEFAULT_SETTINGS, ...settings }),
      host: async () => 'shop.test',
      now: () => 2000,
    },
  });

  it('answers with the whole shape: the diag, the trace, the timeline and the gate', async () => {
    const { log, src } = sources();
    await log.open(7);
    await log.recordRequest(7, { at: 900, req: request(), cacheKey: 'k', promptCacheKey: 'carat-9xyz' });
    const snap = await debugSnapshot(7, src);
    expect(snap).toMatchObject({
      at: 2000,
      tabId: 7,
      on: true,
      gate: { verdict: 'ok', host: 'shop.test', enabled: true, siteOn: true, denylisted: false, snapshot: true },
    });
    expect(snap.diag?.suggest?.kind).toBe('click');
    expect(snap.debug?.request?.promptCacheKey).toBe('carat-9xyz');
    expect(snap.history).toHaveLength(1);
  });

  it('is off, and holds no trace, for a tab whose panel was never opened', async () => {
    const { src } = sources();
    const snap = await debugSnapshot(7, src);
    expect(snap.on).toBe(false);
    expect(snap.debug).toBeNull();
  });

  it('reports each precondition the settings decide', async () => {
    const { src } = sources({ enabled: false, disabledHosts: ['shop.test'] });
    const snap = await debugSnapshot(7, src);
    expect(snap.gate.enabled).toBe(false);
    expect(snap.gate.siteOn).toBe(false);
  });

  it('answers for a tab it cannot name without throwing', async () => {
    const { src } = sources();
    await expect(debugSnapshot(undefined, src)).resolves.toMatchObject({ tabId: null, on: false });
  });
});

describe('the panel', () => {
  let panel: DebugPanel;

  beforeEach(() => {
    clearSurfaces();
    panel = createDebugPanel();
    panel.open();
  });

  afterEach(() => {
    panel.destroy();
    clearSurfaces();
    document.body.innerHTML = '';
  });

  it('draws the request, the answer, the timeline and the gate from a diag', () => {
    panel.render(debugView(snapshot(), extras));
    const text = panel.text;
    for (const heading of ['Request', 'Answer', 'Timeline', 'Gate']) expect(text).toContain(heading);
    // Request: the outline as sent, the three blocks, now, eagerness and both keys.
    expect(text).toContain('[3] button "Continue to payment"');
    expect(text).toContain('<notes>');
    expect(text).toContain('<history>');
    expect(text).toContain('<tabs>');
    expect(text).toContain('2026-09-19T18:00:00.000-04:00');
    expect(text).toContain('eager');
    expect(text).toContain('carat-9xyz');
    // Answer: the action, the raw reply, the race and the timings.
    expect(text).toContain('Click "Continue to payment"');
    expect(text).toContain('"target":3');
    expect(text).toContain('openai');
    expect(text).toContain('model: allowed');
    // Timeline: the tab's history and both sides' events.
    expect(text).toContain('clicked button "Add to cart"');
    expect(text).toContain('warmed — prefix already cached');
    // Gate: every precondition.
    for (const row of ['enabled', 'site on', 'denylisted', 'password field', 'snapshot present', 'hidden', 'snoozed until']) {
      expect(text).toContain(row);
    }
  });

  it('says so, rather than nothing, before the tab has been asked about', () => {
    panel.render(
      debugView({ ...snapshot(), diag: null, debug: { on: true, events: [] }, history: [] }, extras),
    );
    expect(panel.text).toContain('no request from this tab yet');
    expect(panel.text).toContain('nothing has happened on this tab yet');
  });

  it('offers the whole request as JSON, both keys and the outline included', () => {
    const json = debugView(snapshot(), extras).request?.json ?? '';
    expect(JSON.parse(json)).toMatchObject({
      cacheKey: 'shop.test|/cart|abc|1|eager',
      promptCacheKey: 'carat-9xyz',
      request: { eagerness: 'eager', focused: 3, notes: expect.any(Array), history: expect.any(Array) },
    });
    expect(json).toContain('Continue to payment');
  });

  it('never reaches past 45% of the window, wherever it is dragged', () => {
    const host = document.querySelector('[data-carat-debug]') as HTMLElement;
    expect(parseInt(host.style.height, 10)).toBeLessThanOrEqual(Math.round(window.innerHeight * 0.45));
    expect(parseInt(host.style.top, 10)).toBeGreaterThanOrEqual(0);
  });

  it('does not take Tab while the page has focus, and closes on Esc when it has it', () => {
    const host = document.querySelector('[data-carat-debug]') as HTMLElement;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(panel.keys).toBe(0);
    expect(panel.visible).toBe(true);

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, composed: true });
    host.dispatchEvent(tab);
    expect(panel.keys).toBe(1);
    // Tab inside the panel moves focus between its own buttons; it is never swallowed.
    expect(tab.defaultPrevented).toBe(false);

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }));
    expect(panel.visible).toBe(false);
  });
});

describe('the panel and the chip', () => {
  afterEach(() => {
    clearSurfaces();
    document.body.innerHTML = '';
  });

  it('does not count a click inside itself as the user getting on with the page', () => {
    const target = document.createElement('input');
    target.getBoundingClientRect = () => ({ top: 100, left: 20, bottom: 130, right: 220, width: 200, height: 30 }) as DOMRect;
    document.body.append(target);
    const chip = createChip();
    const onDismiss = vi.fn();
    chip.show({ target, label: 'Click "Save"', onAccept: () => undefined, onDismiss });
    expect(chip.visible).toBe(true);

    const panel = createDebugPanel();
    panel.open();
    const host = document.querySelector('[data-carat-debug]') as HTMLElement;
    host.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
    host.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true, composed: true }));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(chip.visible).toBe(true);

    // A click on the page itself still does.
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(onDismiss).toHaveBeenCalledWith('acted');
    panel.destroy();
    chip.destroy();
  });
});

describe('debugView', () => {
  it('merges both sides of the timeline, oldest first, with relative times', () => {
    const view = debugView(snapshot(), {
      ...extras,
      events: [{ at: 1500, source: 'page', name: 'quiet', detail: 'queued' }],
    });
    expect(view.timeline.map((r) => r.text)).toEqual([
      'clicked button "Add to cart"',
      'warmed — prefix already cached',
      'quiet — queued',
    ]);
    expect(view.timeline[0]?.when).toBe('-1.5s');
  });

  it('marks the precondition that is stopping requests', () => {
    const view = debugView(snapshot({ gate: { ...snapshot().gate, verdict: 'password', password: true } }), extras);
    expect(view.gate.find((g) => g.name === 'password field')).toEqual({ name: 'password field', value: 'yes', ok: false });
    expect(view.gate.find((g) => g.name === 'verdict')?.ok).toBe(false);
  });

  it('counts down a Shift+Tab snooze', () => {
    const view = debugView(snapshot(), { ...extras, snoozedUntil: 2000 + 42_000 });
    expect(view.gate.find((g) => g.name === 'snoozed until')?.value).toBe('42s from now');
  });

  it('always says why there is no chip', () => {
    const quiet = snapshot();
    quiet.debug!.answer = { at: 1800, placeholder: null, action: null, attempts: [], validations: [] };
    quiet.diag!.suggest!.silent = 'nothing reached this level’s floor';
    delete quiet.diag!.suggest!.kind;
    const view = debugView(quiet, extras);
    expect(view.answer?.rows).toContainEqual(['no chip because', 'nothing reached this level’s floor']);
  });
});

describe('the trace the engine writes', () => {
  class Talker implements Provider {
    readonly id = 'openai' as const;
    constructor(private readonly reply: NextAction | null) {}
    async next(_req: NextActionRequest, opts: NextOptions): Promise<NextAction | null> {
      opts.onRaw?.('{"target":3,"kind":"click","label":"Continue to payment"}');
      return this.reply;
    }
  }

  const page = {
    page: { host: 'shop.test', title: 'Cart', path: '/cart', scroll: { y: 0.4, pages: 2.2, more: true } },
    outline: 'main:\n  [3] button "Continue to payment"',
    controls: [{ n: 3, role: 'button' as const, name: 'Continue to payment' }],
    focused: 3,
  };

  beforeEach(() => clearActionCache());

  it('records the request as sent and the answer as decided', async () => {
    const patches: Array<{ request?: unknown; answer?: unknown }> = [];
    await nextAction(page, { tabId: 7, origin: 'https://shop.test' }, {
      settings: async () => ({ ...DEFAULT_SETTINGS, apiKey: 'k' }),
      localProvider: { id: 'local', next: async () => null },
      createProvider: () => new Talker(action()),
      notes: { lines: async () => ['Dinner at Seven Shores Cafe'] },
      onDebug: (patch) => patches.push(patch),
    });
    const out = patches.find((p) => p.request)?.request as { req: NextActionRequest; promptCacheKey: string };
    expect(out.req.outline).toBe(page.outline);
    expect(out.req.notes).toEqual(['Dinner at Seven Shores Cafe']);
    expect(out.promptCacheKey).toMatch(/^carat-/);

    const back = patches.find((p) => p.answer)?.answer as { action: NextAction | null; raw?: string; validations: string[] };
    expect(back.action?.label).toBe('Click "Continue to payment"');
    expect(back.raw).toContain('"target":3');
    expect(back.validations).toEqual(['placeholder: nothing to allow', 'model: allowed']);
  });

  it('says which pass the validator refused, and that it asked again', async () => {
    const patches: Array<{ answer?: { validations: string[] } }> = [];
    await nextAction(page, { tabId: 7, origin: 'https://shop.test' }, {
      settings: async () => ({ ...DEFAULT_SETTINGS, apiKey: 'k' }),
      localProvider: { id: 'local', next: async () => null },
      createProvider: () => new Talker(action({ target: 99 })),
      onDebug: (patch) => patches.push(patch as { answer?: { validations: string[] } }),
    });
    const validations = patches.find((p) => p.answer)?.answer?.validations ?? [];
    expect(validations).toContain('model: refused, no such control on the page');
    expect(validations).toContain('asked again after "no such control on the page"');
  });

  it('still answers the page with no panel open, and assembles nothing extra', async () => {
    const seen: string[] = [];
    const res = await nextAction(page, { tabId: 7, origin: 'https://shop.test' }, {
      settings: async () => ({ ...DEFAULT_SETTINGS, apiKey: 'k' }),
      localProvider: { id: 'local', next: async () => null },
      createProvider: () => new Talker(action()),
      onDiag: (d) => seen.push(d.gate),
    });
    expect(res.action?.kind).toBe('click');
    expect(seen).toEqual(['ok']);
  });
});
