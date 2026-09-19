import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ActionSuggestion, ContextItem, ElementDescriptor, FillSuggestion, InteractSuggestion, NavSuggestion, Settings, Suggestion, SuggestRequest } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
import type { Provider } from '@carat/providers';
import { LocalProvider, RaceProvider, createProvider } from '@carat/providers';
import { ContextStore, EntityStore } from '../src/store';
import type { StorageArea } from '../src/store';
import type { SuggestDiag } from '../src/background';
import {
  DiagLog,
  MAX_PERFORMS,
  RefineQueue,
  explainGate,
  fingerprintMatchesDescriptor,
  gate,
  handleFeedback,
  hasWork,
  isExtensionPage,
  orchestrate,
  ownContext,
  performNavigation,
  prewarmKey,
  redactSettings,
  resolveNavigation,
  scoreAndPickContext,
} from '../src/background';
import type { TabsApi } from '../src/background';

class FakeArea implements StorageArea {
  data: Record<string, unknown> = {};
  async get(keys: string[]) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.data, structuredClone(items));
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k];
  }
}

const MIN = 60_000;
const NOW = 10_000_000;

function item(over: Partial<ContextItem> = {}): ContextItem {
  return {
    id: 'c1',
    tabId: 1,
    origin: 'https://discord.com',
    path: '/channels/1',
    title: 'Discord',
    kind: 'page',
    text: 'alex: dinner at Seven Shores Cafe, Friday at 6?',
    hash: 1,
    capturedAt: NOW - MIN,
    lastSeenAt: NOW - MIN,
    ...over,
  };
}

const maps = {
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' },
  fields: [{ i: 'f0', t: 'input:text', nm: 'searchboxinput', ph: 'Search Google Maps', f: 1 as const }],
};
const requester = { tabId: 2, origin: 'https://www.google.com' };
// The product default is eager; `careful` is the old behaviour, for the checks that are about it.
const enabled: Settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-test' };
const careful: Settings = { ...enabled, eagerness: 'balanced' };

describe('gate', () => {
  it('passes with a fresh item from another tab and origin', () => {
    expect(gate(maps, [item()], enabled, requester, NOW)).toBe(true);
  });

  it('needs a different tab AND a different origin for fills below eager, or the requesting tab itself for actions', () => {
    // Same origin from another tab is an echo of what the user is looking at, unless eager says otherwise.
    expect(gate(maps, [item({ origin: 'https://www.google.com' })], careful, requester, NOW)).toBe(false);
    expect(gate(maps, [item({ origin: 'https://www.google.com' })], { ...enabled, eagerness: 'conservative' }, requester, NOW)).toBe(false);
    expect(gate(maps, [item({ origin: 'https://www.google.com' })], enabled, requester, NOW)).toBe(true);
    // The requesting tab's own page is a source for navigation, so it clears the gate on its own.
    expect(gate(maps, [item({ tabId: 2 })], enabled, requester, NOW)).toBe(true);
    expect(gate(maps, [item({ tabId: 2, lastSeenAt: NOW - 31 * MIN })], enabled, requester, NOW)).toBe(false);
  });

  it('at eager, still refuses the requesting tab itself as a fill source and keeps the freshness window', () => {
    const noOwnText = { ...maps, page: { ...maps.page, host: 'www.google.com' } };
    // Only the requesting tab's own item, on a request that is not from a tab: no other tab to draw on.
    expect(gate(noOwnText, [item({ tabId: 2, origin: 'https://www.google.com' })], enabled, { tabId: undefined, origin: 'https://www.google.com' }, NOW)).toBe(false);
    expect(gate(maps, [item({ origin: 'https://www.google.com', lastSeenAt: NOW - 31 * MIN })], enabled, requester, NOW)).toBe(false);
  });

  it('ignores items older than the store TTL', () => {
    expect(gate(maps, [item({ lastSeenAt: NOW - 31 * MIN })], enabled, requester, NOW)).toBe(false);
    expect(gate(maps, [item({ lastSeenAt: NOW - 29 * MIN })], enabled, requester, NOW)).toBe(true);
  });

  it('refuses denylisted hosts, disabled, and no fields', () => {
    const bank = { ...maps, page: { ...maps.page, host: 'secure.chase.com' } };
    expect(gate(bank, [item()], enabled, requester, NOW)).toBe(false);
    expect(gate(maps, [item()], { ...enabled, enabled: false }, requester, NOW)).toBe(false);
    expect(gate({ ...maps, fields: [] }, [item()], enabled, requester, NOW)).toBe(false);
  });

  it('refuses a host the user switched off, and only that host', () => {
    const off = { ...enabled, disabledHosts: ['www.google.com'] };
    expect(gate(maps, [item()], off, requester, NOW)).toBe(false);
    const calendar = { ...maps, page: { ...maps.page, host: 'calendar.google.com' } };
    expect(gate(calendar, [item()], off, requester, NOW)).toBe(true);
  });
});

describe('explainGate', () => {
  it('names the check that stopped the request', () => {
    expect(explainGate(maps, [item()], enabled, requester, NOW)).toBe('ok');
    expect(explainGate(maps, [item()], { ...enabled, enabled: false }, requester, NOW)).toBe('disabled');
    expect(explainGate(maps, [item()], { ...enabled, disabledHosts: ['www.google.com'] }, requester, NOW)).toBe('site-off');
    const bank = { ...maps, page: { ...maps.page, host: 'secure.chase.com' } };
    expect(explainGate(bank, [item()], enabled, requester, NOW)).toBe('denylisted');
    expect(explainGate({ ...maps, fields: [] }, [item()], enabled, requester, NOW)).toBe('no-fields');
    expect(explainGate(maps, [], enabled, requester, NOW)).toBe('no-context');
    // Another tab on the same site is an echo below eager; the requesting tab's own text is a source for actions.
    expect(explainGate(maps, [item({ origin: 'https://www.google.com' })], careful, requester, NOW)).toBe('own-context');
    expect(explainGate(maps, [item({ origin: 'https://www.google.com' })], enabled, requester, NOW)).toBe('ok');
    expect(explainGate(maps, [item({ tabId: 2 })], enabled, requester, NOW)).toBe('ok');
    expect(explainGate(maps, [item({ lastSeenAt: NOW - 31 * MIN })], enabled, requester, NOW)).toBe('stale-context');
    expect(explainGate(maps, [item({ tabId: 2, lastSeenAt: NOW - 31 * MIN })], enabled, requester, NOW)).toBe('stale-context');
    // A stale foreign item plus a fresh own one still passes: the own one can carry an action.
    expect(explainGate(maps, [item({ lastSeenAt: NOW - 31 * MIN }), item({ tabId: 2 })], enabled, requester, NOW)).toBe('ok');
  });
});

describe('DiagLog', () => {
  it('keeps the last capture and check per tab, persists, and forgets the oldest tabs', async () => {
    const area = new FakeArea();
    const log = new DiagLog(area);
    await log.recordCapture(1, { at: 1, host: 'discord.com', kind: 'page', verdict: 'stored' });
    await log.recordSuggest(1, { at: 2, host: 'discord.com', fields: 1, gate: 'own-context' });
    await log.recordSuggest(1, { at: 3, host: 'discord.com', fields: 2, gate: 'ok', cached: false, offered: 1 });
    await log.flush();
    const reloaded = new DiagLog(area);
    expect(await reloaded.get(1)).toEqual({
      capture: { at: 1, host: 'discord.com', kind: 'page', verdict: 'stored' },
      suggest: { at: 3, host: 'discord.com', fields: 2, gate: 'ok', cached: false, offered: 1 },
    });
    expect(await reloaded.get(2)).toBeUndefined();

    for (let t = 10; t < 40; t++) await log.recordCapture(t, { at: 100 + t, host: 'x', kind: 'page', verdict: 'empty' });
    expect(await log.get(1)).toBeUndefined();
    expect(await log.get(10)).toBeUndefined();
    expect(await log.get(39)).toBeDefined();
  });
});

describe('perform log', () => {
  it('keeps the last few performs per tab, newest last', async () => {
    const log = new DiagLog(new FakeArea());
    for (let i = 0; i < MAX_PERFORMS + 2; i++) {
      await log.recordPerform(1, { at: i, host: 'aircanada.com', kind: 'money', name: `Pay ${i}`, outcome: 'done' });
    }
    const performs = (await log.get(1))!.performs!;
    expect(performs).toHaveLength(MAX_PERFORMS);
    expect(performs.at(-1)!.name).toBe(`Pay ${MAX_PERFORMS + 1}`);
  });

  it('logs an accepted money control and a fill that stopped short, and nothing else', async () => {
    const store = new ContextStore(new FakeArea());
    const seen: Array<[number, string, string]> = [];
    const sinks = { onPerform: (tabId: number, e: { kind: string; name: string }) => void seen.push([tabId, e.kind, e.name]) };
    const money = { kind: 'interact' as const, host: 'aircanada.com', role: 'button', name: 'Pay $312.40', accepted: true, money: true as const };
    await handleFeedback(money, store, 7, sinks);
    // A money control the user dismissed is suppressed like any other, and not logged.
    await handleFeedback({ ...money, accepted: false, money: undefined }, store, 7, sinks);
    await handleFeedback({ kind: 'interact', host: 'aircanada.com', role: 'button', name: 'Continue', accepted: true }, store, 7, sinks);
    await handleFeedback({ fieldId: 'f2', fingerprint: 'fp', contextId: 'c1', accepted: true, host: 'aircanada.com', outcome: 'partial' }, store, 7, sinks);
    await handleFeedback({ fieldId: 'f3', fingerprint: 'fp', contextId: 'c1', accepted: true, host: 'aircanada.com' }, store, 7, sinks);
    expect(seen).toEqual([
      [7, 'money', 'Pay $312.40'],
      [7, 'fill', 'f2'],
    ]);
    // The partial fill still counts as a fill on that tab, so the next request may offer the button that commits it.
    expect(await store.recentFillSources(7)).toEqual(['c1']);
  });
});

describe('scoreAndPickContext', () => {
  it('ranks selections above pages and keeps at most three within 3600 chars', () => {
    const items = [
      item({ id: 'p1', text: 'a'.repeat(4000), lastSeenAt: NOW }),
      item({ id: 's1', kind: 'selection', text: 'sel', tabId: 3, lastSeenAt: NOW - 5 * MIN }),
      item({ id: 'p2', text: 'p2', tabId: 4, lastSeenAt: NOW - MIN }),
      item({ id: 'p3', text: 'p3', tabId: 5, lastSeenAt: NOW - 2 * MIN }),
    ];
    const picked = scoreAndPickContext(items, requester, NOW);
    expect(picked.map((c) => c.id)).toEqual(['s1', 'p1', 'p2']);
    expect(picked[1]?.text.length).toBe(3600 - 3 - 2);
    const total = picked.reduce((n, c) => n + c.text.length, 0);
    expect(total).toBeLessThanOrEqual(3600);
  });

  it('splits the budget evenly between two full pages so neither is cut to a header', () => {
    const chat = `Discord | #general · discord.com ${'someone: lol ok '.repeat(300)}`.slice(0, 3900);
    const discord = item({ id: 'd', text: `${chat} alex: dinner at Seven Shores Cafe, Friday at 6?`, lastSeenAt: NOW - MIN });
    const place = item({
      id: 'm',
      tabId: 3,
      origin: 'https://maps.google.com',
      text: `Seven Shores Cafe · maps.google.com 10 Regina St N, Waterloo ${'review text '.repeat(400)}`.slice(0, 4000),
      lastSeenAt: NOW,
    });
    const calendar = { tabId: 4, origin: 'https://calendar.google.com' };
    for (const items of [[place, discord], [discord, place]]) {
      const picked = scoreAndPickContext(items, calendar, NOW);
      expect(picked.map((c) => c.text.length)).toEqual([1800, 1800]);
    }
    const [, tail] = scoreAndPickContext([place, discord], calendar, NOW);
    expect(tail?.text.length).toBeGreaterThan(1000);
  });

  it('excludes the requesting tab always, and its origin below eager', () => {
    const items = [item({ tabId: 2 }), item({ id: 'x', origin: 'https://www.google.com', tabId: 9 })];
    expect(scoreAndPickContext(items, requester, NOW, 'balanced')).toEqual([]);
    expect(scoreAndPickContext(items, requester, NOW, 'conservative')).toEqual([]);
    expect(scoreAndPickContext(items, requester, NOW, 'eager').map((c) => c.id)).toEqual(['x']);
    // Without a tab id there is no telling the asker's own text from another tab's, so only the origin rule is left, at eager too.
    expect(scoreAndPickContext(items, { tabId: undefined, origin: 'https://www.google.com' }, NOW, 'eager').map((c) => c.id)).toEqual(['c1']);
  });
});

describe('fingerprintMatchesDescriptor', () => {
  it('matches on name/placeholder/aria-label with truncation', () => {
    const fp = 'INPUT|text|searchboxinput|searchboxinput|Search Google Maps|Search Google Maps';
    expect(fingerprintMatchesDescriptor(fp, { i: 'f0', t: 'input:text', nm: 'searchboxinput' })).toBe(true);
    expect(fingerprintMatchesDescriptor(fp, { i: 'f0', t: 'input:text', ph: 'Search Goog…' })).toBe(true);
    expect(fingerprintMatchesDescriptor(fp, { i: 'f0', t: 'input:text', nm: 'q' })).toBe(false);
    expect(fingerprintMatchesDescriptor(fp, { i: 'f0', t: 'textarea', nm: 'searchboxinput' })).toBe(false);
  });
});

function fakeProvider(
  id: Provider['id'],
  impl: (req: SuggestRequest, signal: AbortSignal, onUnderFloor?: (s: Suggestion) => void) => Promise<Suggestion[]>,
): Provider & { calls: number } {
  const p = {
    id,
    calls: 0,
    suggest(req: SuggestRequest, opts: { signal: AbortSignal; onUnderFloor?: (s: Suggestion) => void }) {
      p.calls++;
      return impl(req, opts.signal, opts.onUnderFloor);
    },
  };
  return p;
}

const suggestion = (over: Partial<FillSuggestion> = {}): FillSuggestion => ({
  kind: 'fill',
  fieldId: 'f0',
  value: 'Seven Shores Cafe',
  confidence: 0.9,
  reason: 'r',
  sourceContextId: 'c1',
  ...over,
});

async function seeded() {
  let clock = NOW;
  const store = new ContextStore(new FakeArea(), { now: () => clock });
  await store.upsertPage({
    tabId: 1,
    url: 'https://discord.com/channels/1',
    title: 'Discord',
    text: 'alex: dinner at Seven Shores Cafe, Friday at 6?',
  });
  const [ctx] = await store.items();
  return { store, ctxId: ctx!.id, now: () => clock, tick: (ms: number) => (clock += ms) };
}

describe('orchestrate', () => {
  it('returns provider suggestions, one per field, top 2 below eager and top 4 at eager', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async () => [
      suggestion({ sourceContextId: ctxId, confidence: 0.8 }),
      suggestion({ sourceContextId: ctxId, confidence: 0.95, value: 'Better' }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f1', confidence: 0.85 }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f2', confidence: 0.75 }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f3', confidence: 0.5 }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f4', confidence: 0.6 }),
    ]);
    const input = {
      ...maps,
      fields: [...maps.fields, { i: 'f1', t: 'textarea' }, { i: 'f2', t: 'textarea' }, { i: 'f3', t: 'textarea' }, { i: 'f4', t: 'textarea' }],
    };
    const res = await orchestrate(input, requester, {
      store,
      settings: async () => careful,
      createProvider: () => remote,
      now,
    });
    expect(res.suggestions.map((s) => [s.fieldId, s.value])).toEqual([
      ['f0', 'Better'],
      ['f1', 'Seven Shores Cafe'],
    ]);
    // The chip can say where it came from, but never gets the text itself.
    expect(res.suggestions[0]?.source).toEqual({ host: 'discord.com', capturedAt: NOW });
    expect(Object.keys(res.suggestions[0]!)).not.toContain('text');

    // Eager: four of the five fields, best first; the content script shows them one at a time.
    const eager = await orchestrate(input, requester, { store, settings: async () => enabled, createProvider: () => remote, now });
    expect(eager.suggestions.map((s) => [s.fieldId, s.confidence])).toEqual([
      ['f0', 0.95],
      ['f1', 0.85],
      ['f2', 0.75],
      ['f4', 0.6],
    ]);
  });

  it('applies the level\'s floor, counts what fell under it for the popup, and keys the cache by level', async () => {
    const { store, ctxId, now } = await seeded();
    const reports: SuggestDiag[] = [];
    const remote = fakeProvider('openai', async () => [
      suggestion({ sourceContextId: ctxId, confidence: 0.6 }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f1', confidence: 0.4 }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f2', confidence: 0.3 }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f9', confidence: 0.1 }), // no such field: junk, not a near miss
    ]);
    const input = { ...maps, fields: [...maps.fields, { i: 'f1', t: 'textarea' }, { i: 'f2', t: 'textarea' }] };
    const deps = { store, createProvider: () => remote, now, onDiag: (d: SuggestDiag) => void reports.push(d) };

    const eager = await orchestrate(input, requester, { ...deps, settings: async () => enabled });
    expect(eager.suggestions.map((s) => s.fieldId)).toEqual(['f0', 'f1']);
    expect(reports[0]).toMatchObject({ eagerness: 'eager', underFloor: 1, offered: 2 });

    // A different level is a different cache entry: the provider is asked again and the stricter floor applies.
    const balanced = await orchestrate(input, requester, { ...deps, settings: async () => careful });
    expect(remote.calls).toBe(2);
    expect(balanced.suggestions.map((s) => s.fieldId)).toEqual(['f0']);
    expect(reports[1]).toMatchObject({ eagerness: 'balanced', underFloor: 2, offered: 1 });

    const conservative = await orchestrate(input, requester, { ...deps, settings: async () => ({ ...enabled, eagerness: 'conservative' as const }) });
    expect(conservative.suggestions).toEqual([]);
    expect(reports[2]).toMatchObject({ eagerness: 'conservative', underFloor: 3, offered: 0 });

    // Drops the provider itself reports count too.
    const dropping = fakeProvider('openai', async (_req, _signal, onUnderFloor) => {
      onUnderFloor?.(suggestion({ sourceContextId: ctxId, confidence: 0.2 }));
      return [];
    });
    await orchestrate({ ...input, force: true }, requester, { ...deps, createProvider: () => dropping, settings: async () => enabled });
    expect(reports[3]).toMatchObject({ cached: false, underFloor: 1, offered: 0 });
  });

  it('at eager, fills from another tab on the same site; never from the requesting tab', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async (req) => req.context.map((c) => suggestion({ sourceContextId: c.id })));
    // The only item is Discord's, from tab 1; a second Discord tab asks.
    const asker = { tabId: 3, origin: 'https://discord.com' };
    const eager = await orchestrate(maps, asker, { store, settings: async () => enabled, createProvider: () => remote, now });
    expect(eager.suggestions.map((s) => s.sourceContextId)).toEqual([ctxId]);
    expect(remote.calls).toBe(1);
    // The tab that captured it gets nothing: its own text is never a fill source, and the
    // other tab's cached answer is not served to it either (context and own text key the cache apart).
    const self = await orchestrate(maps, { tabId: 1, origin: 'https://discord.com' }, { store, settings: async () => enabled, createProvider: () => remote, now });
    expect(self.suggestions).toEqual([]);
    expect(remote.calls).toBe(2);
  });

  it('returns nothing when the gate fails and never calls the provider', async () => {
    const { store, now } = await seeded();
    const remote = fakeProvider('openai', async () => [suggestion()]);
    // Same origin as the only item, from a tab that has captured nothing of its own: shut out below eager.
    const res = await orchestrate(maps, { tabId: 9, origin: 'https://discord.com' }, {
      store,
      settings: async () => careful,
      createProvider: () => remote,
      now,
    });
    expect(res.suggestions).toEqual([]);
    expect(remote.calls).toBe(0);
  });

  it('falls back to the local provider when the provider throws', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async () => {
      throw new Error('boom');
    });
    const local = fakeProvider('local', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.75 })]);
    const res = await orchestrate(maps, requester, {
      store,
      settings: async () => enabled,
      createProvider: () => remote,
      localProvider: local,
      now,
    });
    expect(res.suggestions).toHaveLength(1);
    expect(local.calls).toBe(1);
  });

  it('falls back to the real local provider when the real network provider cannot reach the API', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const httpError = (status: number) => vi.fn(async () => new Response('{}', { status }));
    for (const fetchImpl of [offline, httpError(401), httpError(429), httpError(500)]) {
      const { store, now } = await seeded();
      const res = await orchestrate(maps, requester, {
        store,
        settings: async () => enabled,
        createProvider: (s) => createProvider(s, fetchImpl as unknown as typeof fetch),
        now,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(res.suggestions.map((s) => [s.fieldId, s.value])).toEqual([['f0', 'Seven Shores Cafe']]);
    }
  });

  it('races regex, Jev and the chat model inside one call when the provider is cloudflare', async () => {
    const cloudflare: Settings = { ...enabled, provider: 'cloudflare', cfAccountId: 'acct', cfApiToken: 'cf' };
    const envelope = (answers: Record<string, unknown>) =>
      new Response(JSON.stringify({ success: true, errors: [], result: { model: 'jev', answers } }), { status: 200 });
    const completion = (value: string, sourceContextId: string) =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [{ fieldId: 'f0', value, confidence: 0.9, reason: 'r', sourceContextId }] }) } }] }),
        { status: 200 },
      );

    // Jev picks the regex candidate; the chat model, asked at the same time, has nothing to add.
    {
      const { store, now } = await seeded();
      const empty = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [] }) } }] }), { status: 200 });
      const fetchImpl = vi.fn(async (url: string) =>
        String(url).includes('api.cloudflare.com')
          ? envelope({ relevant: { type: 'noul', noul: 0.9 }, field_f0: { type: 'choice', choice: 'k0', confidence: 0.9, probabilities: { k0: 0.9, k1: 0.05, none: 0.05 } } })
          : empty(),
      );
      const res = await orchestrate(maps, requester, { store, settings: async () => cloudflare, createProvider: (s) => createProvider(s, fetchImpl as unknown as typeof fetch), now });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).host).sort()).toEqual(['api.cloudflare.com', 'api.openai.com']);
      expect(res.suggestions.map((s) => [s.fieldId, s.value])).toEqual([['f0', 'Seven Shores Cafe']]);
    }
    // Jev says none; the chat model, on the same budget, outranks the regex answer.
    {
      const { store, ctxId, now } = await seeded();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(envelope({ relevant: { type: 'noul', noul: 0.2 } }))
        .mockResolvedValueOnce(completion('From the model', ctxId));
      const res = await orchestrate(maps, requester, { store, settings: async () => cloudflare, createProvider: (s) => createProvider(s, fetchImpl as unknown as typeof fetch), now });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(String((fetchImpl.mock.calls[1] as unknown as [string])[0])).toContain('api.openai.com');
      expect(res.suggestions.map((s) => s.value)).toEqual(['From the model']);
    }
    // No chat key: Jev alone beside regex, and an error envelope leaves the regex answer.
    {
      const { store, now } = await seeded();
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 401 }));
      const res = await orchestrate(maps, requester, { store, settings: async () => ({ ...cloudflare, apiKey: '' }), createProvider: (s) => createProvider(s, fetchImpl as unknown as typeof fetch), now });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(res.suggestions.map((s) => [s.fieldId, s.value])).toEqual([['f0', 'Seven Shores Cafe']]);
    }
  });

  it('falls back to the local provider when the provider times out', async () => {
    const { store, ctxId, now } = await seeded();
    let aborted = false;
    const remote = fakeProvider('openai', (_req, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        });
      });
    });
    const local = fakeProvider('local', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.75 })]);
    const res = await orchestrate(maps, requester, {
      store,
      settings: async () => enabled,
      createProvider: () => remote,
      localProvider: local,
      now,
      timeoutMs: 20,
    });
    expect(aborted).toBe(true);
    expect(res.suggestions).toHaveLength(1);
  });

  it('drops a hung provider that ignores the signal', async () => {
    const { store, now } = await seeded();
    const remote = fakeProvider('local', () => new Promise(() => undefined));
    const res = await orchestrate(maps, requester, {
      store,
      settings: async () => ({ ...enabled, apiKey: '' }),
      createProvider: () => remote,
      now,
      timeoutMs: 20,
    });
    expect(res.suggestions).toEqual([]);
  });

  it('serves the second identical request from cache', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId })]);
    const deps = { store, settings: async () => enabled, createProvider: () => remote, now };
    const a = await orchestrate(maps, requester, deps);
    const b = await orchestrate(maps, requester, deps);
    expect(a).toEqual(b);
    expect(remote.calls).toBe(1);
  });

  it('reports the gate verdict, each provider attempt and the cache hit', async () => {
    const { store, ctxId, now } = await seeded();
    const reports: SuggestDiag[] = [];
    const flaky = fakeProvider('openai', async () => {
      throw new Error('HTTP 503');
    });
    const local = fakeProvider('local', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.75 })]);
    const deps = {
      store,
      settings: async () => careful,
      createProvider: () => flaky,
      localProvider: local,
      now,
      onDiag: (d: SuggestDiag) => void reports.push(d),
    };
    // A second Discord tab asking: the only context is the same site's, and not its own.
    await orchestrate(maps, { tabId: 3, origin: 'https://discord.com' }, deps);
    expect(reports[0]).toMatchObject({ at: NOW, host: 'www.google.com', fields: 1, gate: 'own-context', eagerness: 'balanced' });

    await orchestrate(maps, requester, deps);
    expect(reports[1]).toMatchObject({ gate: 'ok', cached: false, offered: 1 });
    expect(reports[1]?.attempts?.map((a) => [a.id, a.count, a.error])).toEqual([
      ['openai', 0, 'HTTP 503'],
      ['local', 1, undefined],
    ]);

    const steady = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId })]);
    const steadyDeps = { ...deps, createProvider: () => steady };
    await orchestrate(maps, requester, steadyDeps);
    await orchestrate(maps, requester, steadyDeps);
    expect(reports[2]).toMatchObject({ gate: 'ok', cached: false, offered: 1 });
    expect(reports[3]).toMatchObject({ gate: 'ok', cached: true, offered: 1 });
    expect(reports[3]?.attempts).toBeUndefined();
  });

  it('keeps offering pinned context after it would have gone stale', async () => {
    const { store, ctxId, now, tick } = await seeded();
    const remote = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId })]);
    const deps = { store, settings: async () => enabled, createProvider: () => remote, now };
    await store.pin();
    tick(45 * MIN);
    expect((await orchestrate(maps, requester, deps)).suggestions).toHaveLength(1);
    await store.unpin();
    expect((await orchestrate(maps, requester, deps)).suggestions).toEqual([]);
  });

  it('caches a genuine empty answer but never a failure', async () => {
    const { store, ctxId, now } = await seeded();
    const empty = fakeProvider('openai', async () => []);
    const deps = { store, settings: async () => enabled, createProvider: () => empty, now };
    await orchestrate(maps, requester, deps);
    await orchestrate(maps, requester, deps);
    expect(empty.calls).toBe(1);

    let down = true;
    const flaky = fakeProvider('openai', async () => {
      if (down) throw new Error('HTTP 503');
      return [suggestion({ sourceContextId: ctxId })];
    });
    const local = fakeProvider('local', async () => []);
    const other = { ...maps, fields: [{ i: 'f0', t: 'input:text', nm: 'q' }] };
    const flakyDeps = { store, settings: async () => enabled, createProvider: () => flaky, localProvider: local, now };
    expect((await orchestrate(other, requester, flakyDeps)).suggestions).toEqual([]);
    down = false;
    expect((await orchestrate(other, requester, flakyDeps)).suggestions).toHaveLength(1);
    expect(flaky.calls).toBe(2);
  });

  it('filters suggestions the user already accepted for that field', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId })]);
    const deps = { store, settings: async () => enabled, createProvider: () => remote, now };
    expect((await orchestrate(maps, requester, deps)).suggestions).toHaveLength(1);
    await handleFeedback(
      {
        fieldId: 'f0',
        fingerprint: 'INPUT|text|searchboxinput|searchboxinput|Search Google Maps|Search Google Maps',
        contextId: ctxId,
        accepted: true,
        host: 'www.google.com',
      },
      store,
    );
    expect((await orchestrate(maps, requester, deps)).suggestions).toEqual([]);
    // A different field on the same host is still eligible.
    const other = { ...maps, fields: [{ i: 'f0', t: 'input:text', nm: 'q' }] };
    expect((await orchestrate(other, requester, deps)).suggestions).toHaveLength(1);
  });

  it('a forced request skips the cache and shows what the user dismissed', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId })]);
    const deps = { store, settings: async () => enabled, createProvider: () => remote, now };
    expect((await orchestrate(maps, requester, deps)).suggestions).toHaveLength(1);
    await handleFeedback(
      {
        fieldId: 'f0',
        fingerprint: 'INPUT|text|searchboxinput|searchboxinput|Search Google Maps|Search Google Maps',
        contextId: ctxId,
        accepted: false,
        host: 'www.google.com',
      },
      store,
    );
    expect((await orchestrate(maps, requester, deps)).suggestions).toEqual([]);
    expect(remote.calls).toBe(1);

    expect((await orchestrate({ ...maps, force: true }, requester, deps)).suggestions).toHaveLength(1);
    expect(remote.calls).toBe(2);
  });

  it('never suggests into a field that already has a value', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId })]);
    const filled = { ...maps, fields: [{ ...maps.fields[0]!, v: 'typed' }] };
    const res = await orchestrate(filled, requester, {
      store,
      settings: async () => enabled,
      createProvider: () => remote,
      now,
    });
    expect(res.suggestions).toEqual([]);
  });

  it('falls back to the local provider when the provider factory throws', async () => {
    const { store, ctxId, now } = await seeded();
    const local = fakeProvider('local', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.75 })]);
    const res = await orchestrate(maps, requester, {
      store,
      settings: async () => enabled,
      createProvider: () => {
        throw new Error('bad settings');
      },
      localProvider: local,
      now,
    });
    expect(local.calls).toBe(1);
    expect(res.suggestions).toHaveLength(1);
  });

  it('gives the fallback only what is left of the budget', async () => {
    const { store, now } = await seeded();
    const hang = () => new Promise<Suggestion[]>(() => undefined);
    const remote = fakeProvider('openai', hang);
    const local = fakeProvider('local', hang);
    const started = Date.now();
    const res = await orchestrate(maps, requester, {
      store,
      settings: async () => enabled,
      createProvider: () => remote,
      localProvider: local,
      now,
      timeoutMs: 50,
    });
    // remote burns the whole budget; the fallback gets the floor (= timeoutMs when smaller than 1s), not a fresh one
    expect(Date.now() - started).toBeLessThan(50 * 2 + 400);
    expect(local.calls).toBe(1);
    expect(res.suggestions).toEqual([]);
  });
});

const smartOn: Settings = { ...enabled, screenshots: true };
const idle = { hasPending: () => false, settled: async () => undefined };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('orchestrate smart path', () => {
  it('issues the fast request without waiting on any vision work', async () => {
    const { store, ctxId, now } = await seeded();
    const order: string[] = [];
    const fast = fakeProvider('openai', async () => {
      order.push('fast');
      return [suggestion({ sourceContextId: ctxId, confidence: 0.8 })];
    });
    const smart = fakeProvider('openai', () => {
      order.push('smart');
      return new Promise(() => undefined); // hangs for good
    });
    let settle!: () => void;
    const vision = { hasPending: () => true, settled: () => new Promise<void>((r) => (settle = r)) };
    const refine = new RefineQueue(() => undefined);

    const started = performance.now();
    const res = await orchestrate(maps, requester, {
      store,
      settings: async () => smartOn,
      createProvider: () => fast,
      createSmartProvider: () => smart,
      refine,
      vision,
      now,
      smartTimeoutMs: 1000,
    });
    const elapsed = performance.now() - started;

    expect(res.suggestions.map((s) => s.value)).toEqual(['Seven Shores Cafe']);
    expect(typeof res.ticket).toBe('string');
    expect(elapsed).toBeLessThan(100);
    // The smart model has not even been asked: it is waiting on the transcription, which the fast reply did not.
    expect(order).toEqual(['fast']);

    settle();
    expect(await refine.claim(res.ticket!, requester.tabId)).toEqual({ suggestions: [], interactions: [] }); // hung past its own budget
    expect(order).toEqual(['fast', 'smart']);
  });

  it('shows the regex answer first, hands over a surer fast answer and then a surer smart one, and serves the merged answer from cache afterwards', async () => {
    const { store, ctxId, now } = await seeded();
    const fast = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.8, value: 'Seven Shores' })]);
    const smart = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.92, value: 'Seven Shores Cafe' })]);
    const refine = new RefineQueue(() => undefined);
    const deps = { store, settings: async () => smartOn, createProvider: () => fast, createSmartProvider: () => smart, refine, vision: idle, now };

    const first = await orchestrate(maps, requester, deps);
    expect(first.suggestions.map((s) => [s.value, s.confidence])).toEqual([['Seven Shores Cafe', 0.75]]);
    expect(await drain(refine, first.ticket!, requester.tabId)).toEqual([
      [expect.objectContaining({ value: 'Seven Shores', confidence: 0.8 })],
      [expect.objectContaining({ value: 'Seven Shores Cafe', confidence: 0.92 })],
    ]);

    const second = await orchestrate(maps, requester, deps);
    expect(second.suggestions.map((s) => [s.value, s.confidence])).toEqual([['Seven Shores Cafe', 0.92]]);
    expect(second.ticket).toBeUndefined();
    expect(fast.calls).toBe(1);
    expect(smart.calls).toBe(1);
  });

  it('hands nothing over when the later answers change no chip, and caches the surest of them', async () => {
    const { store, ctxId, now } = await seeded();
    const fast = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.8, value: 'Seven Shores Cafe' })]);
    const smart = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.8, value: 'Other' })]);
    const refine = new RefineQueue(() => undefined);
    const deps = { store, settings: async () => smartOn, createProvider: () => fast, createSmartProvider: () => smart, refine, vision: idle, now };
    const res = await orchestrate(maps, requester, deps);
    expect(res.suggestions.map((s) => [s.value, s.confidence])).toEqual([['Seven Shores Cafe', 0.75]]);
    // The fast model agreed with the regex value and the smart model was no surer: the chip is left alone.
    expect(await drain(refine, res.ticket!, requester.tabId)).toEqual([]);
    expect(smart.calls).toBe(1);
    const again = await orchestrate(maps, requester, deps);
    expect(again.suggestions.map((s) => [s.value, s.confidence])).toEqual([['Seven Shores Cafe', 0.8]]);
    expect(again.ticket).toBeUndefined();
  });

  it('answers from a screenshot the fast path could not wait for', async () => {
    let clock = NOW;
    const store = new ContextStore(new FakeArea(), { now: () => clock });
    const fast = fakeProvider('openai', async () => [suggestion()]);
    const smart = fakeProvider('openai', async (req) => [suggestion({ sourceContextId: req.context[0]!.id, confidence: 0.88 })]);
    const vision = {
      hasPending: () => true,
      settled: async () => {
        await store.upsertVision({
          tabId: 1,
          url: 'https://discord.com/channels/1',
          title: 'Discord',
          text: 'Discord · discord.com alex: dinner at Seven Shores Cafe, Friday at 6?',
        });
      },
    };
    const refine = new RefineQueue(() => undefined);
    const res = await orchestrate(maps, requester, {
      store,
      settings: async () => smartOn,
      createProvider: () => fast,
      createSmartProvider: () => smart,
      refine,
      vision,
      now: () => clock,
    });
    expect(res.suggestions).toEqual([]);
    expect(fast.calls).toBe(0);
    expect(typeof res.ticket).toBe('string');

    const out = await refine.claim(res.ticket!, requester.tabId);
    const [item] = await store.items();
    expect(item?.kind).toBe('vision');
    expect(out.suggestions).toEqual([expect.objectContaining({ fieldId: 'f0', sourceContextId: item!.id })]);
    expect(smart.calls).toBe(1);
  });

  it('makes no smart call when it cannot help', async () => {
    const { store, ctxId, now } = await seeded();
    const sure = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.95 })]);
    const unsure = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.75 })]);
    const smart = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.99, value: 'Other' })]);
    const refine = new RefineQueue(() => undefined);
    const base = { store, createProvider: () => unsure, createSmartProvider: () => smart, refine, vision: idle, now };
    const fields = (nm: string) => ({ ...maps, fields: [{ i: 'f0', t: 'input:text', nm }] });

    // screenshots off
    expect((await orchestrate(fields('a'), requester, { ...base, settings: async () => enabled })).ticket).toBeUndefined();
    // the fast answer is already sure
    expect((await orchestrate(fields('b'), requester, { ...base, createProvider: () => sure, settings: async () => smartOn })).ticket).toBeUndefined();
    // no smart provider (local, or no key)
    expect((await orchestrate(fields('c'), requester, { ...base, createSmartProvider: () => undefined, settings: async () => smartOn })).ticket).toBeUndefined();
    // the smart path is not wired at all
    expect((await orchestrate(fields('d'), requester, { ...base, refine: undefined, settings: async () => smartOn })).ticket).toBeUndefined();
    // no context and nothing on its way
    expect(await orchestrate(fields('e'), { tabId: 1, origin: 'https://discord.com' }, { ...base, settings: async () => smartOn })).toEqual({
      suggestions: [],
      navigation: [],
      interactions: [],
    });
    expect(smart.calls).toBe(0);
    await tick();
  });
});

/** Every answer a ticket gives, polled as the content script polls it: again while `more`, until it says nothing. */
async function drain(refine: RefineQueue, ticket: string, tabId: number): Promise<Suggestion[][]> {
  const out: Suggestion[][] = [];
  for (;;) {
    const res = await refine.claim(ticket, tabId);
    const got = [...res.suggestions, ...res.interactions];
    if (got.length === 0 && !res.more) return out;
    if (got.length > 0) out.push(got);
    if (!res.more) return out;
  }
}

// vitest runs each package from its own directory.
const FIXTURES = resolve(process.cwd(), '../../packages/providers/eval/fixtures');

describe('orchestrate first answer', () => {
  it('answers Discord to Maps from the regex pass in under 50 ms while a 2s chat model runs on, then hands the chat answer over', async () => {
    const fixture = JSON.parse(readFileSync(resolve(FIXTURES, 'discord-maps-search.json'), 'utf8')) as { request: SuggestRequest };
    const source = fixture.request.context[0]!;
    let clock = NOW;
    const store = new ContextStore(new FakeArea(), { now: () => clock });
    await store.upsertPage({ tabId: 1, url: `${source.origin}/channels/1`, title: source.title, text: source.text });
    const [ctx] = await store.items();
    const chat = fakeProvider(
      'openai',
      (_req, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve([suggestion({ sourceContextId: ctx!.id, confidence: 0.93, value: 'Seven Shores Cafe, Waterloo' })]), 2000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(signal.reason);
          });
        }),
    );
    const refine = new RefineQueue(() => undefined);
    const reports: SuggestDiag[] = [];
    const deps = {
      store,
      settings: async () => enabled,
      refine,
      createProvider: () => new RaceProvider([new LocalProvider(), chat], { id: 'openai' as const }),
      now: () => clock,
      onDiag: (d: SuggestDiag) => void reports.push(structuredClone(d)),
    };
    const input = { page: fixture.request.page, fields: fixture.request.fields };

    const started = performance.now();
    const res = await orchestrate(input, requester, deps);
    const firstMs = performance.now() - started;
    expect(res.suggestions.map((s) => [s.fieldId, s.value, s.confidence])).toEqual([['f0', 'Seven Shores Cafe', 0.75]]);
    expect(firstMs).toBeLessThan(50);
    expect(typeof res.ticket).toBe('string');
    expect(chat.calls).toBe(1);
    expect(reports[0]).toMatchObject({ source: 'local', refine: true });

    const answers = await drain(refine, res.ticket!, requester.tabId);
    const chatMs = performance.now() - started;
    expect(answers).toEqual([[expect.objectContaining({ fieldId: 'f0', value: 'Seven Shores Cafe, Waterloo', confidence: 0.93 })]]);
    expect(chatMs).toBeGreaterThanOrEqual(1900);
    expect(reports.at(-1)).toMatchObject({ refined: 1 });
    expect(reports.at(-1)?.attempts?.map((a) => [a.id, a.count])).toEqual([['local', 1], ['openai', 1]]);

    // The merged answer is what the next request gets from cache, with no call.
    const again = await orchestrate(input, requester, deps);
    expect(again.suggestions.map((s) => [s.value, s.confidence])).toEqual([['Seven Shores Cafe, Waterloo', 0.93]]);
    expect(again.ticket).toBeUndefined();
    expect(chat.calls).toBe(1);
  }, 10_000);

  it('answers from entities predicted at capture time with no call, then lets the chat model refine', async () => {
    const { store, ctxId, now } = await seeded();
    const entities = new EntityStore(new FakeArea());
    const [item] = await store.items();
    await entities.set(item!, [{ value: 'Seven Shores Cafe', kind: 'place', fieldHints: ['search'], confidence: 0.92 }], 'model');
    const chat = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.95, value: 'Seven Shores Cafe, Waterloo' })]);
    const refine = new RefineQueue(() => undefined);
    const reports: SuggestDiag[] = [];
    const res = await orchestrate(maps, requester, {
      store,
      entities,
      refine,
      settings: async () => enabled,
      createProvider: () => chat,
      now,
      onDiag: (d) => void reports.push(structuredClone(d)),
    });
    expect(res.suggestions.map((s) => [s.value, s.confidence])).toEqual([['Seven Shores Cafe', 0.92]]);
    expect(reports[0]).toMatchObject({ source: 'entities', refine: true, cached: false });
    expect(await drain(refine, res.ticket!, requester.tabId)).toEqual([[expect.objectContaining({ value: 'Seven Shores Cafe, Waterloo', confidence: 0.95 })]]);
    expect(reports.at(-1)).toMatchObject({ refined: 1, attempts: [expect.objectContaining({ id: 'openai', count: 1 })] });
  });

  it('shows the regex answer but leaves the cache alone when the chat model fails, so the next request asks again', async () => {
    const { store, now } = await seeded();
    const chat = fakeProvider('openai', async () => {
      throw new Error('HTTP 503');
    });
    const refine = new RefineQueue(() => undefined);
    const deps = { store, refine, settings: async () => enabled, createProvider: () => new RaceProvider([new LocalProvider(), chat], { id: 'openai' as const }), now };
    const res = await orchestrate(maps, requester, deps);
    expect(res.suggestions.map((s) => s.value)).toEqual(['Seven Shores Cafe']);
    expect(await drain(refine, res.ticket!, requester.tabId)).toEqual([]);
    await orchestrate(maps, requester, deps);
    expect(chat.calls).toBe(2);
  });

  it('answers from the cache a navigation pre-warmed, adopted onto the live field, with no call', async () => {
    const { store, ctxId, now } = await seeded();
    const context = scoreAndPickContext(await store.items(), requester, NOW);
    await store.setCached(prewarmKey('maps', context), [suggestion({ sourceContextId: ctxId, confidence: 0.9 })]);
    const chat = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.95, value: 'Other' })]);
    const reports: SuggestDiag[] = [];
    // The live page numbered the box f3.
    const live = { ...maps, fields: [{ i: 'f3', t: 'input:text', nm: 'searchboxinput', ph: 'Search Google Maps', f: 1 as const }] };
    const res = await orchestrate(live, requester, {
      store,
      refine: new RefineQueue(() => undefined),
      settings: async () => enabled,
      createProvider: () => chat,
      now,
      onDiag: (d) => void reports.push(structuredClone(d)),
    });
    expect(res.suggestions.map((s) => [s.fieldId, s.value, s.confidence])).toEqual([['f3', 'Seven Shores Cafe', 0.9]]);
    expect(res.ticket).toBeUndefined();
    expect(chat.calls).toBe(0);
    expect(reports[0]).toMatchObject({ source: 'prewarm', prewarmed: true, cached: false });
  });

  it('waits for the provider as before when there is no queue to hand later answers through', async () => {
    const { store, ctxId, now } = await seeded();
    const chat = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId, confidence: 0.95, value: 'From the model' })]);
    const res = await orchestrate(maps, requester, {
      store,
      settings: async () => enabled,
      createProvider: () => new RaceProvider([new LocalProvider(), chat], { id: 'openai' as const }),
      now,
    });
    expect(res.suggestions.map((s) => s.value)).toEqual(['From the model']);
    expect(res.ticket).toBeUndefined();
  });
});

describe('orchestrate smart path over the whole answer', () => {
  it('merges interactions per element, leaves tab offers as the fast pass made them, and never counts a tab offer as sure', async () => {
    const { store, ctxId, now } = await seeded();
    await store.upsertPage({ tabId: 2, url: 'https://calendar.google.com/calendar/u/0/r/eventedit', title: 'Calendar', text: 'dinner at Seven Shores Cafe, Friday at 6? add it to the calendar' });
    await handleFeedback({ fieldId: 'f0', fingerprint: 'input|text|||Add title|', contextId: ctxId, accepted: true, host: 'calendar.google.com' }, store, 2);
    const ownId = (await store.items()).find((i) => i.tabId === 2)!.id;
    const fast = fakeProvider('openai', async () => [
      interact({ sourceContextId: ctxId, confidence: 0.75 }),
      action({ sourceContextId: ownId, confidence: 0.95 }),
    ]);
    const smart = fakeProvider('openai', async () => [
      interact({ sourceContextId: ctxId, confidence: 0.9, reason: 'surer' }),
      interact({ sourceContextId: ctxId, elementId: 'e1', verb: 'check', value: 'All day', confidence: 0.8 }),
      action({ sourceContextId: ownId, intent: 'calendar', value: 'Something else', confidence: 0.99 }),
    ]);
    const refine = new RefineQueue(() => undefined);
    const input = { page: calendarPage, fields: [], elements };
    const res = await orchestrate(input, onCalendar, {
      store,
      settings: async () => smartOn,
      createProvider: () => fast,
      createSmartProvider: () => smart,
      refine,
      vision: idle,
      now,
      tabs: async () => [],
    });
    expect(res.interactions.map((i) => [i.elementId, i.confidence])).toEqual([['e0', 0.75]]);
    expect(res.navigation.map((n) => n.intent)).toEqual(['maps']);
    expect(typeof res.ticket).toBe('string');

    const out = await refine.claim(res.ticket!, onCalendar.tabId);
    expect(out.suggestions).toEqual([]);
    expect(out.interactions.map((i) => [i.elementId, i.verb, i.confidence, i.reason])).toEqual([
      ['e0', 'click', 0.9, 'surer'],
      ['e1', 'check', 0.8, 'r'],
    ]);
    // The merged answer is what the cache now holds, tab offer included and unchanged.
    const again = await orchestrate(input, onCalendar, { store, settings: async () => smartOn, createProvider: () => fast, now, tabs: async () => [] });
    expect(again.interactions.map((i) => [i.elementId, i.confidence])).toEqual([['e0', 0.9], ['e1', 0.8]]);
    expect(again.navigation.map((n) => [n.intent, n.value])).toEqual([['maps', 'Seven Shores Cafe']]);
    expect(fast.calls).toBe(1);
  });

  it('feeds a vision item to the fast path like page text, and counts it as the tab\'s own text for actions', async () => {
    const { store, now } = await seeded();
    await store.upsertVision({ tabId: 1, url: 'https://discord.com/channels/1', title: 'Discord', text: 'Discord · discord.com alex: dinner at Seven Shores Cafe, Friday at 6?' });
    const items = await store.items();
    const vision = items.find((i) => i.kind === 'vision')!;
    expect(gate(maps, [vision], enabled, requester, NOW)).toBe(true);
    expect(scoreAndPickContext([vision], requester, NOW).map((c) => c.kind)).toEqual(['vision']);
    expect(ownContext([vision], { tabId: 1, origin: 'https://discord.com' }, NOW).map((c) => c.id)).toEqual([vision.id]);

    const seen: SuggestRequest[] = [];
    const fast = fakeProvider('openai', async (req) => {
      seen.push(req);
      return [suggestion({ sourceContextId: vision.id })];
    });
    const res = await orchestrate(maps, requester, { store, settings: async () => enabled, createProvider: () => fast, now });
    expect(res.suggestions.map((s) => [s.value, s.source?.host])).toEqual([['Seven Shores Cafe', 'discord.com']]);
    expect(seen[0]!.context.map((c) => c.kind).sort()).toEqual(['page', 'vision']);
  });
});

describe('trusted senders', () => {
  const ext = 'chrome-extension://abcdefgh';

  it('recognises the extension pages and nothing else', () => {
    const base = `${ext}/`;
    expect(isExtensionPage({ url: `${ext}/popup.html`, origin: ext }, base)).toBe(true);
    expect(isExtensionPage({ origin: ext }, base)).toBe(true);
    const tab = { id: 1 } as chrome.tabs.Tab;
    expect(isExtensionPage({ url: 'https://discord.com/channels/1', origin: 'https://discord.com', tab }, base)).toBe(false);
    expect(isExtensionPage({ url: `${ext}.evil.test/x`, origin: 'null' }, base)).toBe(false);
    expect(isExtensionPage({ url: `https://evil.test/?u=${ext}/`, origin: 'https://evil.test' }, base)).toBe(false);
    expect(isExtensionPage({}, base)).toBe(false);
  });

  it('redacts the keys and nothing else', () => {
    const withCloudflare = { ...enabled, cfAccountId: 'acct', cfApiToken: 'cf-secret' };
    expect(redactSettings(withCloudflare)).toEqual({ ...withCloudflare, apiKey: '', cfApiToken: '' });
  });
});

describe('ownContext', () => {
  it('returns the requesting tab\'s fresh page and its best selection, clipped to 2000 chars', () => {
    const items = [
      item({ id: 'page', tabId: 2, text: 'x'.repeat(3000), lastSeenAt: NOW }),
      item({ id: 'old', tabId: 2, kind: 'selection', text: 'old', lastSeenAt: NOW - 8 * MIN }),
      item({ id: 'new', tabId: 2, kind: 'selection', text: 'new', lastSeenAt: NOW - MIN }),
      item({ id: 'stale', tabId: 2, kind: 'selection', text: 'stale', lastSeenAt: NOW - 31 * MIN }),
      item({ id: 'other', tabId: 3, text: 'other tab', lastSeenAt: NOW }),
    ];
    const own = ownContext(items, requester, NOW);
    expect(own.map((c) => c.id).sort()).toEqual(['new', 'page']);
    expect(own.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(2000);
  });

  it('is empty without a tab id', () => {
    expect(ownContext([item({ tabId: 2 })], { tabId: undefined, origin: 'https://x' }, NOW)).toEqual([]);
  });
});

const action = (over: Partial<ActionSuggestion> = {}): ActionSuggestion => ({
  kind: 'action',
  intent: 'maps',
  value: 'Seven Shores Cafe',
  when: '',
  location: '',
  confidence: 0.9,
  reason: 'r',
  sourceContextId: 'o1',
  ...over,
});
const discordPage = { host: 'discord.com', title: 'Discord', path: '/channels/1/2' };
const onDiscord = { tabId: 1, origin: 'https://discord.com' };

describe('resolveNavigation', () => {
  it('opens a new tab when no tab shows the destination and focuses one that does', () => {
    const [open] = resolveNavigation([action()], [{ id: 1, url: 'https://discord.com/channels/1/2' }], onDiscord, discordPage);
    expect(open).toMatchObject({ kind: 'open', label: 'Open in Google Maps', url: 'https://www.google.com/maps/search/?api=1&query=Seven+Shores+Cafe' });
    expect(open?.tabId).toBeUndefined();

    const tabs = [{ id: 1, url: 'https://discord.com/channels/1/2' }, { id: 7, url: 'https://www.google.com/maps/@43.4,-80.5,12z' }];
    const [focus] = resolveNavigation([action()], tabs, onDiscord, discordPage);
    expect(focus).toMatchObject({ kind: 'focus', tabId: 7, label: 'Switch to Google Maps' });
  });

  it('never focuses the requesting tab, drops the destination the user is on, and drops what it cannot build', () => {
    const onMaps = { tabId: 7, origin: 'https://www.google.com' };
    const mapsPage = { host: 'www.google.com', title: 'Maps', path: '/maps' };
    expect(resolveNavigation([action()], [{ id: 7, url: 'https://www.google.com/maps' }], onMaps, mapsPage)).toEqual([]);
    const calendar = action({ intent: 'calendar', value: 'Dinner', when: '2026-09-18T18:00:00-04:00', location: 'Seven Shores Cafe' });
    const [nav] = resolveNavigation([calendar], [{ id: 7, url: 'https://www.google.com/maps' }], onMaps, mapsPage);
    expect(nav?.url).toContain('dates=20260918T180000%2F20260918T190000');
    expect(resolveNavigation([action({ intent: 'gmail', value: 'not an email' })], [], onDiscord, discordPage)).toEqual([]);
  });
});

function fakeTabs(existing?: { id: number; url: string; windowId?: number }) {
  const api = {
    get: vi.fn(async (id: number) => (existing && existing.id === id ? existing : undefined)),
    update: vi.fn(async () => undefined),
    create: vi.fn(async () => undefined),
    focusWindow: vi.fn(async () => undefined),
  } satisfies TabsApi;
  return api;
}

const navOf = (over: Partial<NavSuggestion> = {}): NavSuggestion => ({
  kind: 'open',
  intent: 'maps',
  label: 'Open in Google Maps',
  value: 'Seven Shores Cafe',
  when: '',
  location: '',
  url: 'https://www.google.com/maps/search/?api=1&query=Seven+Shores+Cafe',
  confidence: 0.9,
  reason: 'r',
  sourceContextId: 'o1',
  ...over,
});
const fromTab = { tab: { id: 1 } };

describe('performNavigation', () => {
  it('opens a tab next to the sender with a URL rebuilt from the registry, never the one in the message', async () => {
    const tabs = fakeTabs();
    expect(await performNavigation(navOf({ url: 'https://evil.test/' }), fromTab, tabs)).toEqual({ ok: true });
    expect(tabs.create).toHaveBeenCalledWith({ url: 'https://www.google.com/maps/search/?api=1&query=Seven+Shores+Cafe', openerTabId: 1 });
    expect(tabs.update).not.toHaveBeenCalled();
  });

  it('focuses an existing destination tab, navigates it, and raises its window', async () => {
    const tabs = fakeTabs({ id: 7, url: 'https://www.google.com/maps', windowId: 3 });
    expect(await performNavigation(navOf({ kind: 'focus', tabId: 7 }), fromTab, tabs)).toEqual({ ok: true });
    expect(tabs.update).toHaveBeenCalledWith(7, { url: 'https://www.google.com/maps/search/?api=1&query=Seven+Shores+Cafe', active: true });
    expect(tabs.focusWindow).toHaveBeenCalledWith(3);
    expect(tabs.create).not.toHaveBeenCalled();
  });

  it('falls back to a new tab when the focus target is gone, has left the destination, or is the sender', async () => {
    for (const [tabs, tabId] of [
      [fakeTabs(), 7],
      [fakeTabs({ id: 7, url: 'https://news.ycombinator.com/' }), 7],
      [fakeTabs({ id: 1, url: 'https://www.google.com/maps' }), 1],
    ] as const) {
      expect(await performNavigation(navOf({ kind: 'focus', tabId }), fromTab, tabs)).toEqual({ ok: true });
      expect(tabs.update).not.toHaveBeenCalled();
      expect(tabs.create).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses a sender that is not a tab, an unknown intent, and an entity the registry cannot use', async () => {
    const tabs = fakeTabs();
    expect(await performNavigation(navOf(), {}, tabs)).toEqual({ ok: false });
    expect(await performNavigation(navOf({ intent: 'uber' as NavSuggestion['intent'] }), fromTab, tabs)).toEqual({ ok: false });
    expect(await performNavigation(navOf({ intent: 'gmail', value: 'nobody' }), fromTab, tabs)).toEqual({ ok: false });
    expect(tabs.create).not.toHaveBeenCalled();
    expect(tabs.update).not.toHaveBeenCalled();
  });
});

describe('orchestrate navigation', () => {
  const composer = { ...discordPage, fields: [{ i: 'f0', t: 'textbox', al: 'Message #general', f: 1 as const }] };
  const input = { page: discordPage, fields: composer.fields };
  const local: Settings = { ...DEFAULT_SETTINGS, provider: 'local', apiKey: '' };

  it('offers Maps and Calendar from the page being read, focusing an open Maps tab, and never touches tabs itself', async () => {
    const { store, now } = await seeded();
    const tabs = vi.fn(async () => [{ id: 1, url: 'https://discord.com/channels/1/2' }, { id: 7, url: 'https://maps.google.com/' }]);
    const res = await orchestrate(input, onDiscord, { store, settings: async () => local, now, tabs });
    expect(res.suggestions).toEqual([]);
    expect(res.navigation.map((n) => [n.intent, n.kind, n.tabId])).toEqual([
      ['maps', 'focus', 7],
      ['calendar', 'open', undefined],
    ]);
    expect(res.navigation[0]?.label).toBe('Switch to Google Maps');
    expect(res.navigation[1]?.url).toContain('calendar.google.com');
    expect(tabs).toHaveBeenCalledTimes(1);
  });

  it('drops an action the provider sourced from another tab and a fill sourced from the page itself', async () => {
    const { store, ctxId, now } = await seeded();
    await store.upsertPage({ tabId: 3, url: 'https://app.slack.com/c/1', title: 'Slack', text: 'lunch at Vincenzos tomorrow at 12?' });
    const slackId = (await store.items()).find((i) => i.tabId === 3)!.id;
    const remote = fakeProvider('openai', async () => [
      action({ sourceContextId: slackId }),
      action({ sourceContextId: ctxId, intent: 'calendar', value: 'Dinner' }),
      suggestion({ sourceContextId: ctxId }),
    ]);
    const res = await orchestrate(input, onDiscord, { store, settings: async () => enabled, createProvider: () => remote, now });
    expect(res.suggestions).toEqual([]);
    expect(res.navigation.map((n) => n.intent)).toEqual(['calendar']);
  });

  it('remembers a dismissed or accepted navigation by destination and entity, across page changes', async () => {
    const { store, now } = await seeded();
    const deps = { store, settings: async () => local, now };
    expect((await orchestrate(input, onDiscord, deps)).navigation.map((n) => n.intent)).toEqual(['maps', 'calendar']);
    await handleFeedback({ kind: 'nav', intent: 'maps', value: 'seven shores  cafe', accepted: false }, store);
    expect((await orchestrate(input, onDiscord, deps)).navigation.map((n) => n.intent)).toEqual(['calendar']);
    // The chat scrolls: a new page item, a new context id, the same errand.
    await store.upsertPage({ tabId: 1, url: 'https://discord.com/channels/1', title: 'Discord', text: 'alex: dinner at Seven Shores Cafe, Friday at 6? sam: in' });
    expect((await orchestrate(input, onDiscord, deps)).navigation.map((n) => n.intent)).toEqual(['calendar']);
    await handleFeedback({ kind: 'nav', intent: 'calendar', value: 'Dinner at Seven Shores Cafe', accepted: true }, store);
    expect((await orchestrate(input, onDiscord, deps)).navigation).toEqual([]);
  });

  it('says which of the page\'s own captures a tab offer came from, counts it for the popup, and brings a dismissed one back when forced', async () => {
    const { store, now } = await seeded();
    const reports: SuggestDiag[] = [];
    const deps = { store, settings: async () => local, now, onDiag: (d: SuggestDiag) => void reports.push(d) };
    const first = await orchestrate(input, onDiscord, deps);
    expect(first.navigation.map((n) => n.source)).toEqual([
      { host: 'discord.com', capturedAt: NOW },
      { host: 'discord.com', capturedAt: NOW },
    ]);
    expect(reports[0]).toMatchObject({ gate: 'ok', offered: 0, navigation: 2 });

    await handleFeedback({ kind: 'nav', intent: 'maps', value: 'Seven Shores Cafe', accepted: false }, store);
    expect((await orchestrate(input, onDiscord, deps)).navigation.map((n) => n.intent)).toEqual(['calendar']);
    expect((await orchestrate({ ...input, force: true }, onDiscord, deps)).navigation.map((n) => n.intent)).toEqual(['maps', 'calendar']);
    expect(reports[2]).toMatchObject({ cached: false, navigation: 2 });
  });

  it('does not ask for tabs when there is nothing to navigate to', async () => {
    const { store, ctxId, now } = await seeded();
    const tabs = vi.fn(async () => []);
    const remote = fakeProvider('openai', async () => [suggestion({ sourceContextId: ctxId })]);
    const res = await orchestrate(maps, requester, { store, settings: async () => enabled, createProvider: () => remote, now, tabs });
    expect(res.suggestions).toHaveLength(1);
    expect(res.navigation).toEqual([]);
    expect(tabs).not.toHaveBeenCalled();
  });
});

vi.stubGlobal('navigator', { language: 'en-CA' });

const interact = (over: Partial<InteractSuggestion> = {}): InteractSuggestion => ({
  kind: 'interact',
  elementId: 'e0',
  verb: 'click',
  value: 'Save',
  confidence: 0.85,
  reason: 'r',
  sourceContextId: 'c1',
  ...over,
});
const calendarPage = { host: 'calendar.google.com', title: 'Calendar', path: '/calendar/u/0/r/eventedit' };
const onCalendar = { tabId: 2, origin: 'https://calendar.google.com' };
const elements: ElementDescriptor[] = [
  { i: 'e0', r: 'button', nm: 'Save', p: 1 },
  { i: 'e1', r: 'checkbox', nm: 'All day', st: 'off' },
  { i: 'e2', r: 'slider', nm: 'Volume', v: '80', min: 0, max: 100, step: 1 },
  { i: 'e3', r: 'button', nm: 'Delete event' },
];

describe('hasWork and gate for elements', () => {
  const page = calendarPage;
  it('counts a field, a control, or buttons after a fill; a lone button only when it is the primary action and the level or a flow allows it', () => {
    expect(hasWork({ page, fields: [] })).toBe(false);
    // The primary Save with nothing to fill: work at eager, not below, unless a flow is under way.
    expect(hasWork({ page, fields: [], elements: [elements[0]!] })).toBe(true);
    expect(hasWork({ page, fields: [], elements: [elements[0]!] }, 'balanced')).toBe(false);
    expect(hasWork({ page, fields: [], elements: [elements[0]!], flow: true }, 'conservative')).toBe(true);
    expect(hasWork({ page, fields: [], elements: [{ i: 'e0', r: 'button', nm: 'More options', p: 1 }] })).toBe(false);
    expect(hasWork({ page, fields: [], elements: [{ i: 'e0', r: 'button', nm: 'Save' }] })).toBe(false);
    expect(hasWork({ page, fields: [], elements: [{ i: 'e0', r: 'button', nm: 'Pay now', p: 1, m: 1 }] })).toBe(false);
    expect(hasWork({ page, fields: [], elements: [elements[0]!], filled: ['c1'] })).toBe(true);
    expect(hasWork({ page, fields: [], elements: [elements[1]!] })).toBe(true);
    expect(hasWork({ page, fields: [], elements: [elements[2]!] })).toBe(true);
    expect(hasWork({ page, fields: [{ i: 'f0', t: 'input:text' }] })).toBe(true);
  });

  it('still needs fresh text from somewhere', () => {
    const input = { page, fields: [], elements: [elements[1]!] };
    expect(gate(input, [item()], enabled, onCalendar, NOW)).toBe(true);
    expect(gate(input, [item({ lastSeenAt: NOW - 31 * MIN })], enabled, onCalendar, NOW)).toBe(false);
  });
});

describe('orchestrate interactions', () => {
  // An empty field on the page keeps the primary Save behind the fill rule at every level; the eager no-fill case has its own tests below.
  const emptyField = { i: 'f0', t: 'textarea', al: 'Description' };
  const input = { page: calendarPage, fields: [emptyField], elements };
  const local: Settings = { ...DEFAULT_SETTINGS, provider: 'local', apiKey: '' };

  it('offers the primary continue-style button with no fill behind it at eager once nothing is left to fill, and not below eager', async () => {
    const { store, now } = await seeded();
    const bare = { page: calendarPage, fields: [], elements };
    const at = (eagerness: Settings['eagerness']) => orchestrate(bare, onCalendar, { store, settings: async () => ({ ...local, eagerness }), now });
    expect((await at('eager')).interactions).toEqual([
      expect.objectContaining({ elementId: 'e0', verb: 'click', value: 'Save', confidence: 0.5, sourceContextId: expect.any(String) }),
    ]);
    expect((await at('balanced')).interactions).toEqual([]);
    expect((await at('conservative')).interactions).toEqual([]);
    // With an empty field still on the page, the fill comes first and the button waits.
    expect((await orchestrate(input, onCalendar, { store, settings: async () => local, now })).interactions).toEqual([]);
  });

  it('drops a model click on a non-primary button, and on the primary one when a field is still empty, unless something was filled', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async () => [interact({ sourceContextId: ctxId }), interact({ sourceContextId: ctxId, elementId: 'e3', value: 'Delete event' })]);
    const deps = { store, settings: async () => enabled, createProvider: () => remote, now };
    const bare = { page: calendarPage, fields: [], elements };
    expect((await orchestrate(bare, onCalendar, deps)).interactions.map((s) => s.elementId)).toEqual(['e0']);
    expect((await orchestrate(input, onCalendar, deps)).interactions).toEqual([]);
  });

  it('keeps a money control out unless payments are allowed, and then only through the same click rules', async () => {
    const { store, ctxId, now } = await seeded();
    await handleFeedback({ fieldId: 'f0', fingerprint: 'input|text|||Add title|', contextId: ctxId, accepted: true, host: 'calendar.google.com' }, store, 2);
    const pay = { ...input, elements: [{ i: 'e0', r: 'button' as const, nm: 'Pay now', p: 1 as const, m: 1 as const }] };
    const remote = fakeProvider('openai', async () => [interact({ sourceContextId: ctxId, value: 'Pay now' })]);
    const off = await orchestrate(pay, onCalendar, { store, settings: async () => enabled, createProvider: () => remote, now });
    expect(off.interactions).toEqual([]);
    const on = await orchestrate(pay, onCalendar, { store, settings: async () => ({ ...enabled, allowPayments: true }), createProvider: () => remote, now });
    expect(on.interactions.map((s) => s.value)).toEqual(['Pay now']);
  });

  it('offers the Save button only once carat filled a field on that tab, and remembers that for a minute', async () => {
    const { store, ctxId, now, tick } = await seeded();
    const deps = { store, settings: async () => local, now };
    expect((await orchestrate(input, onCalendar, deps)).interactions).toEqual([]);

    await handleFeedback({ fieldId: 'f0', fingerprint: 'input|text|||Add title|', contextId: ctxId, accepted: true, host: 'calendar.google.com' }, store, 2);
    const res = await orchestrate(input, onCalendar, deps);
    expect(res.interactions).toEqual([
      {
        kind: 'interact',
        elementId: 'e0',
        verb: 'click',
        value: 'Save',
        confidence: 0.75,
        reason: expect.any(String),
        sourceContextId: ctxId,
        source: { host: 'discord.com', capturedAt: expect.any(Number) },
      },
    ]);
    // Another tab's fill says nothing about this one.
    expect((await orchestrate(input, { ...onCalendar, tabId: 5 }, deps)).interactions).toEqual([]);
    tick(61 * 1000);
    expect((await orchestrate(input, onCalendar, deps)).interactions).toEqual([]);
  });

  it('keeps only interactions that name a described element, fit its state and range, cite a real source, and are not destructive', async () => {
    const { store, ctxId, now } = await seeded();
    await handleFeedback({ fieldId: 'f0', fingerprint: 'input|text|||Add title|', contextId: ctxId, accepted: true, host: 'calendar.google.com' }, store, 2);
    const remote = fakeProvider('openai', async () => [
      interact({ sourceContextId: ctxId }),
      interact({ sourceContextId: ctxId, elementId: 'e0', confidence: 0.9, reason: 'better' }),
      interact({ sourceContextId: ctxId, elementId: 'e1', verb: 'uncheck', value: 'All day' }), // already off
      interact({ sourceContextId: ctxId, elementId: 'e1', verb: 'check', value: 'All day', confidence: 0.5 }), // too weak
      interact({ sourceContextId: ctxId, elementId: 'e2', verb: 'set', value: '140' }), // out of range
      interact({ sourceContextId: ctxId, elementId: 'e2', verb: 'set', value: '40' }),
      interact({ sourceContextId: 'nope', elementId: 'e2', verb: 'set', value: '30' }), // unknown source
      interact({ sourceContextId: ctxId, elementId: 'e3', value: 'Delete event' }), // destructive
      interact({ sourceContextId: ctxId, elementId: 'e9', value: 'Ghost' }), // not described
      interact({ sourceContextId: ctxId, elementId: 'e0', verb: 'set', value: '1' }), // wrong verb for a button
    ]);
    const res = await orchestrate(input, onCalendar, { store, settings: async () => careful, createProvider: () => remote, now });
    expect(res.interactions.map((s) => [s.elementId, s.verb, s.value, s.reason])).toEqual([
      ['e0', 'click', 'Save', 'better'],
      ['e2', 'set', '40', 'r'],
    ]);
  });

  it('keeps a scroll to an off-screen element, rewrites one to an on-screen element as the verb it implies, and drops the rest', async () => {
    const { store, ctxId, now } = await seeded();
    await handleFeedback({ fieldId: 'f0', fingerprint: 'input|text|||Add title|', contextId: ctxId, accepted: true, host: 'calendar.google.com' }, store, 2);
    const scrollable = {
      ...input,
      elements: [
        { i: 'e0', r: 'button' as const, nm: 'Save', p: 1 as const, o: 1 as const },
        { i: 'e1', r: 'checkbox' as const, nm: 'All day', st: 'off' as const },
        { i: 'e2', r: 'slider' as const, nm: 'Volume', v: '80', min: 0, max: 100, step: 1 },
        { i: 'e3', r: 'button' as const, nm: 'Delete event', o: 1 as const },
      ],
    };
    const remote = fakeProvider('openai', async () => [
      interact({ sourceContextId: ctxId, elementId: 'e0', verb: 'scroll', value: '', confidence: 0.9 }), // off-screen: stays a scroll
      interact({ sourceContextId: ctxId, elementId: 'e1', verb: 'scroll', value: '', confidence: 0.8 }), // on-screen box: becomes a check
      interact({ sourceContextId: ctxId, elementId: 'e2', verb: 'scroll', value: '', confidence: 0.85 }), // on-screen slider: nothing implied
      interact({ sourceContextId: ctxId, elementId: 'e3', verb: 'scroll', value: '', confidence: 0.95 }), // destructive, off-screen or not
      interact({ sourceContextId: ctxId, elementId: 'e0', verb: 'scroll', value: 'Save', confidence: 0.99 }), // a scroll carries no value
    ]);
    const res = await orchestrate(scrollable, onCalendar, { store, settings: async () => enabled, createProvider: () => remote, now });
    expect(res.interactions.map((s) => [s.elementId, s.verb, s.value])).toEqual([
      ['e0', 'scroll', ''],
      ['e1', 'check', 'All day'],
    ]);
  });

  it('turns a cached scroll into a click once the button is on-screen, and drops it when nothing was filled', async () => {
    const { store, ctxId, now } = await seeded();
    await handleFeedback({ fieldId: 'f0', fingerprint: 'input|text|||Add title|', contextId: ctxId, accepted: true, host: 'calendar.google.com' }, store, 2);
    const remote = fakeProvider('openai', async () => [interact({ sourceContextId: ctxId, elementId: 'e0', verb: 'scroll', value: '' })]);
    const deps = { store, settings: async () => enabled, createProvider: () => remote, now };
    const below = { ...input, elements: [{ i: 'e0', r: 'button' as const, nm: 'Save', p: 1 as const, o: 1 as const }] };
    expect((await orchestrate(below, onCalendar, deps)).interactions.map((s) => s.verb)).toEqual(['scroll']);

    // Same answer from the cache, button now in view: the click it stood in for.
    const inView = { ...input, elements: [{ i: 'e0', r: 'button' as const, nm: 'Save', p: 1 as const }] };
    const again = await orchestrate(inView, onCalendar, deps);
    expect(again.interactions.map((s) => [s.verb, s.value])).toEqual([['click', 'Save']]);
    expect(remote.calls).toBe(1);

    // A click still needs a fill behind it; another tab's fill does not count.
    expect((await orchestrate(inView, { ...onCalendar, tabId: 5 }, deps)).interactions).toEqual([]);
  });

  it('never lets the model click a button on a page carat filled nothing on', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async () => [interact({ sourceContextId: ctxId }), interact({ sourceContextId: ctxId, elementId: 'e2', verb: 'set', value: '40' })]);
    const res = await orchestrate(input, onCalendar, { store, settings: async () => enabled, createProvider: () => remote, now });
    expect(res.interactions.map((s) => s.elementId)).toEqual(['e2']);
  });

  it('suppresses an element for 10 minutes after Esc and not at all after an accept', async () => {
    const { store, ctxId, now, tick } = await seeded();
    const remote = fakeProvider('openai', async () => [interact({ sourceContextId: ctxId, elementId: 'e2', verb: 'set', value: '40' })]);
    const deps = { store, settings: async () => enabled, createProvider: () => remote, now };
    expect((await orchestrate(input, onCalendar, deps)).interactions).toHaveLength(1);

    await handleFeedback({ kind: 'interact', host: 'calendar.google.com', role: 'slider', name: 'VOLUME ', accepted: false }, store, 2);
    expect((await orchestrate(input, onCalendar, deps)).interactions).toEqual([]);
    tick(10 * MIN + 1);
    // The Discord tab is still open and fresh; only the dismissal has aged out.
    await store.upsertPage({ tabId: 1, url: 'https://discord.com/channels/1', title: 'Discord', text: 'alex: dinner at Seven Shores Cafe, Friday at 6?' });
    expect((await orchestrate(input, onCalendar, deps)).interactions).toHaveLength(1);

    await handleFeedback({ kind: 'interact', host: 'calendar.google.com', role: 'slider', name: 'Volume', accepted: true }, store, 2);
    expect((await orchestrate(input, onCalendar, deps)).interactions).toHaveLength(1);
    expect(await store.suppressedKeys()).toEqual([]);
  });

  it('caps interactions at two below eager and four at eager, one per element, best first', async () => {
    const { store, ctxId, now } = await seeded();
    await handleFeedback({ fieldId: 'f0', fingerprint: 'input|text|||Add title|', contextId: ctxId, accepted: true, host: 'calendar.google.com' }, store, 2);
    const many = { ...input, elements: [...elements, { i: 'e4', r: 'checkbox' as const, nm: 'Vegetarian', st: 'off' as const }] };
    const remote = fakeProvider('openai', async () => [
      interact({ sourceContextId: ctxId, confidence: 0.8 }),
      interact({ sourceContextId: ctxId, elementId: 'e1', verb: 'check', value: 'All day', confidence: 0.9 }),
      interact({ sourceContextId: ctxId, elementId: 'e4', verb: 'check', value: 'Vegetarian', confidence: 0.95 }),
      interact({ sourceContextId: ctxId, elementId: 'e4', verb: 'check', value: 'Vegetarian', confidence: 0.75 }),
    ]);
    const res = await orchestrate(many, onCalendar, { store, settings: async () => careful, createProvider: () => remote, now });
    expect(res.interactions.map((s) => [s.elementId, s.confidence])).toEqual([
      ['e4', 0.95],
      ['e1', 0.9],
    ]);
    const eager = await orchestrate(many, onCalendar, { store, settings: async () => enabled, createProvider: () => remote, now });
    expect(eager.interactions.map((s) => [s.elementId, s.confidence])).toEqual([
      ['e4', 0.95],
      ['e1', 0.9],
      ['e0', 0.8],
    ]);
  });

  it('counts elements and interactions for the popup, stops at the site switch, and brings a dismissed one back when forced', async () => {
    const { store, ctxId, now } = await seeded();
    const reports: SuggestDiag[] = [];
    const remote = fakeProvider('openai', async () => [interact({ sourceContextId: ctxId, elementId: 'e2', verb: 'set', value: '40' })]);
    const deps = { store, settings: async () => enabled, createProvider: () => remote, now, onDiag: (d: SuggestDiag) => void reports.push(d) };
    expect((await orchestrate(input, onCalendar, deps)).interactions).toHaveLength(1);
    expect(reports[0]).toMatchObject({ gate: 'ok', fields: 1, elements: 4, offered: 0, navigation: 0, interactions: 1 });

    const off = { ...enabled, disabledHosts: ['calendar.google.com'] };
    expect((await orchestrate(input, onCalendar, { ...deps, settings: async () => off })).interactions).toEqual([]);
    expect(reports[1]).toMatchObject({ gate: 'site-off' });

    await handleFeedback({ kind: 'interact', host: 'calendar.google.com', role: 'slider', name: 'Volume', accepted: false }, store, 2);
    expect((await orchestrate(input, onCalendar, deps)).interactions).toEqual([]);
    expect((await orchestrate({ ...input, force: true }, onCalendar, deps)).interactions).toHaveLength(1);
    expect(reports[3]).toMatchObject({ cached: false, interactions: 1 });
  });
});
