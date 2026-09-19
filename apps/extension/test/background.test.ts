import { describe, expect, it, vi } from 'vitest';
import type { ContextItem, Settings, Suggestion, SuggestRequest } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
import type { Provider } from '@carat/providers';
import { createProvider } from '@carat/providers';
import { ContextStore } from '../src/store';
import type { StorageArea } from '../src/store';
import type { SuggestDiag } from '../src/background';
import {
  DiagLog,
  explainGate,
  fingerprintMatchesDescriptor,
  gate,
  handleFeedback,
  isExtensionPage,
  orchestrate,
  redactSettings,
  scoreAndPickContext,
} from '../src/background';

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
const enabled: Settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-test' };

describe('gate', () => {
  it('passes with a fresh item from another tab and origin', () => {
    expect(gate(maps, [item()], enabled, requester, NOW)).toBe(true);
  });

  it('needs a different tab AND a different origin', () => {
    expect(gate(maps, [item({ tabId: 2 })], enabled, requester, NOW)).toBe(false);
    expect(gate(maps, [item({ origin: 'https://www.google.com' })], enabled, requester, NOW)).toBe(false);
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
    expect(explainGate(maps, [item({ tabId: 2 })], enabled, requester, NOW)).toBe('own-context');
    expect(explainGate(maps, [item({ lastSeenAt: NOW - 31 * MIN })], enabled, requester, NOW)).toBe('stale-context');
    // A stale foreign item plus a fresh own one is still "stale": the own one could never be used.
    expect(explainGate(maps, [item({ lastSeenAt: NOW - 31 * MIN }), item({ tabId: 2 })], enabled, requester, NOW)).toBe('stale-context');
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

  it('excludes the requesting tab and origin', () => {
    const items = [item({ tabId: 2 }), item({ id: 'x', origin: 'https://www.google.com', tabId: 9 })];
    expect(scoreAndPickContext(items, requester, NOW)).toEqual([]);
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
  impl: (req: SuggestRequest, signal: AbortSignal) => Promise<Suggestion[]>,
): Provider & { calls: number } {
  const p = {
    id,
    calls: 0,
    suggest(req: SuggestRequest, opts: { signal: AbortSignal }) {
      p.calls++;
      return impl(req, opts.signal);
    },
  };
  return p;
}

const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({
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
  it('returns provider suggestions, top 2, one per field', async () => {
    const { store, ctxId, now } = await seeded();
    const remote = fakeProvider('openai', async () => [
      suggestion({ sourceContextId: ctxId, confidence: 0.8 }),
      suggestion({ sourceContextId: ctxId, confidence: 0.95, value: 'Better' }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f1', confidence: 0.85 }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f2', confidence: 0.75 }),
      suggestion({ sourceContextId: ctxId, fieldId: 'f3', confidence: 0.5 }),
    ]);
    const input = {
      ...maps,
      fields: [...maps.fields, { i: 'f1', t: 'textarea' }, { i: 'f2', t: 'textarea' }, { i: 'f3', t: 'textarea' }],
    };
    const res = await orchestrate(input, requester, {
      store,
      settings: async () => enabled,
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
  });

  it('returns nothing when the gate fails and never calls the provider', async () => {
    const { store, now } = await seeded();
    const remote = fakeProvider('openai', async () => [suggestion()]);
    const res = await orchestrate(maps, { tabId: 1, origin: 'https://discord.com' }, {
      store,
      settings: async () => enabled,
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
      settings: async () => enabled,
      createProvider: () => flaky,
      localProvider: local,
      now,
      onDiag: (d: SuggestDiag) => void reports.push(d),
    };
    await orchestrate(maps, { tabId: 1, origin: 'https://discord.com' }, deps);
    expect(reports[0]).toMatchObject({ at: NOW, host: 'www.google.com', fields: 1, gate: 'own-context' });

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

  it('redacts the key and nothing else', () => {
    expect(redactSettings(enabled)).toEqual({ ...enabled, apiKey: '' });
  });
});

vi.stubGlobal('navigator', { language: 'en-CA' });
