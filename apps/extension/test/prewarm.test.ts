import { describe, expect, it } from 'vitest';
import type { FillSuggestion, Settings, SuggestRequest, Suggestion } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
import { KNOWN_PAGES, knownPageFor, knownPageForUrl, matchesKnownField } from '@carat/shared/src/known-fields';
import type { KnownPage } from '@carat/shared/src/known-fields';
import type { Provider } from '@carat/providers';
import { ContextStore } from '../src/store';
import type { StorageArea } from '../src/store';
import { adoptFills, createPrewarmer, lookupPrewarmed, prewarmKey } from '../src/background/prewarm';
import type { CommitDetails, PrewarmDeps, PrewarmDiag, WebNavigationApi } from '../src/background/prewarm';
import { scoreAndPickContext } from '../src/background';

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

const NOW = 10_000_000;
const MIN = 60_000;
const enabled: Settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-test' };
const MAPS = 'https://www.google.com/maps';
const DISCORD_TAB = 1;
const MAPS_TAB = 2;

function fakeProvider(answer: (req: SuggestRequest) => Suggestion[] | Promise<Suggestion[]>) {
  const p = {
    id: 'openai' as const,
    calls: 0,
    requests: [] as SuggestRequest[],
    async suggest(req: SuggestRequest) {
      p.calls++;
      p.requests.push(req);
      return answer(req);
    },
  };
  return p satisfies Provider;
}

/** A webNavigation whose events the test fires by hand. */
function fakeWebNavigation() {
  const listeners: Array<(d: CommitDetails) => void> = [];
  const api: WebNavigationApi & { commit(d: Partial<CommitDetails> & { url: string }): void } = {
    onCommitted: { addListener: (cb) => listeners.push(cb) },
    commit: (d) => {
      for (const cb of listeners) cb({ tabId: MAPS_TAB, frameId: 0, ...d });
    },
  };
  return api;
}

const fill = (over: Partial<FillSuggestion> = {}): FillSuggestion => ({
  kind: 'fill',
  fieldId: 'f0',
  value: 'Seven Shores Cafe',
  confidence: 0.9,
  reason: 'r',
  sourceContextId: 'c1',
  ...over,
});

async function setup(over: Partial<PrewarmDeps> & { context?: boolean; settings?: () => Promise<Settings> } = {}) {
  let clock = NOW;
  const store = new ContextStore(new FakeArea(), { now: () => clock });
  let ctxId = '';
  if (over.context !== false) {
    const item = await store.upsertPage({
      tabId: DISCORD_TAB,
      url: 'https://discord.com/channels/1',
      title: 'Discord',
      text: 'alex: dinner at Seven Shores Cafe, Friday at 6?',
    });
    ctxId = item!.id;
  }
  const provider = fakeProvider(() => [fill({ sourceContextId: ctxId })]);
  const diags: Array<[number, PrewarmDiag]> = [];
  const { context: _context, ...rest } = over;
  const prewarmer = createPrewarmer({
    store,
    settings: async () => enabled,
    createProvider: () => provider,
    now: () => clock,
    onDiag: (tabId, d) => diags.push([tabId, d]),
    ...rest,
  });
  const nav = fakeWebNavigation();
  prewarmer.attach(nav);
  return { store, provider, prewarmer, nav, diags, ctxId, tick: (ms: number) => (clock += ms) };
}

describe('known pages', () => {
  it('names the four destinations and nothing else', () => {
    expect(knownPageForUrl(MAPS)?.id).toBe('maps');
    expect(knownPageForUrl('https://www.google.com/maps/@43.4,-80.5,15z')?.id).toBe('maps');
    expect(knownPageForUrl('https://calendar.google.com/calendar/u/0/r/eventedit')?.id).toBe('calendar');
    expect(knownPageForUrl('https://mail.google.com/mail/u/0/#inbox')?.id).toBe('gmail');
    expect(knownPageForUrl('https://www.google.com/')?.id).toBe('search');
    expect(knownPageForUrl('https://www.google.com/search?q=x')).toBeUndefined();
    expect(knownPageForUrl('https://calendar.google.com/calendar/u/0/r/week')).toBeUndefined();
    expect(knownPageForUrl('https://discord.com/channels/1')).toBeUndefined();
    expect(knownPageForUrl('chrome://extensions')).toBeUndefined();
    expect(knownPageForUrl('not a url')).toBeUndefined();
  });

  it('skips a deep link that already carries the value', () => {
    expect(knownPageForUrl('https://www.google.com/maps/search/?api=1&query=Seven+Shores')).toBeUndefined();
    expect(knownPageForUrl('https://calendar.google.com/calendar/u/0/r/eventedit?text=Dinner')).toBeUndefined();
    expect(knownPageForUrl('https://mail.google.com/mail/?view=cm&fs=1&to=a%40b.co')).toBeUndefined();
  });

  it('finds the same page from a live snapshot host and path', () => {
    expect(knownPageFor('www.google.com', '/maps/search/Seven+Shores')?.id).toBe('maps');
    expect(knownPageFor('www.google.com', '/')?.id).toBe('search');
    expect(knownPageFor('mail.google.com', '/mail/u/0/')?.id).toBe('gmail');
    expect(knownPageFor('discord.com', '/channels/1')).toBeUndefined();
  });

  it('matches a live field on type plus name, label or placeholder', () => {
    const known = KNOWN_PAGES.find((p) => p.id === 'maps')!.fields[0]!;
    expect(matchesKnownField(known, { i: 'f3', t: 'input:text', nm: 'searchboxinput', w: 'l' })).toBe(true);
    expect(matchesKnownField(known, { i: 'f3', t: 'input:text', ph: 'search google maps' })).toBe(true);
    expect(matchesKnownField(known, { i: 'f3', t: 'textarea', nm: 'searchboxinput' })).toBe(false);
    expect(matchesKnownField(known, { i: 'f3', t: 'input:text', nm: 'q' })).toBe(false);
  });
});

describe('prewarm on navigation', () => {
  it('fires one provider call on a Maps commit with fresh Discord context and fills the cache', async () => {
    const { store, provider, prewarmer, nav, diags, ctxId } = await setup();
    nav.commit({ url: MAPS });
    await prewarmer.settled();

    expect(provider.calls).toBe(1);
    const req = provider.requests[0]!;
    expect(req.page).toEqual({ host: 'www.google.com', title: 'Google Maps', path: '/maps' });
    expect(req.fields.map((f) => f.nm)).toEqual(['searchboxinput']);
    expect(req.context.map((c) => c.id)).toEqual([ctxId]);
    expect(req.own).toBeUndefined();
    expect(req.elements).toBeUndefined();

    const context = scoreAndPickContext(await store.items(), { tabId: MAPS_TAB, origin: 'https://www.google.com' }, NOW);
    expect(await store.getCached(prewarmKey('maps', context))).toEqual([fill({ sourceContextId: ctxId })]);
    expect(diags).toEqual([[MAPS_TAB, { at: NOW, host: 'www.google.com', verdict: 'warmed', count: 1, attempts: [expect.objectContaining({ id: 'openai', count: 1 })] }]]);
  });

  it('does not call again for a second commit within 60s, and does again once the cache has expired', async () => {
    const { provider, prewarmer, nav, diags, tick } = await setup();
    nav.commit({ url: MAPS });
    await prewarmer.settled();
    tick(30 * 1000);
    nav.commit({ url: 'https://www.google.com/maps/@43.4,-80.5,15z' });
    await prewarmer.settled();
    expect(provider.calls).toBe(1);
    expect(diags.map(([, d]) => d.verdict)).toEqual(['warmed', 'warm']);

    tick(31 * 1000);
    nav.commit({ url: MAPS });
    await prewarmer.settled();
    expect(provider.calls).toBe(2);
  });

  it('runs one call for two commits that overlap', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { provider, prewarmer, nav, ctxId } = await setup();
    provider.suggest = async () => {
      provider.calls++;
      await held;
      return [fill({ sourceContextId: ctxId })];
    };
    nav.commit({ url: MAPS });
    nav.commit({ url: MAPS });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await prewarmer.settled();
    expect(provider.calls).toBe(1);
  });

  it('never fires for a denylisted host, even one listed as a known page', async () => {
    const bank: KnownPage = {
      id: 'search',
      page: { host: 'app.chase.com', title: 'Chase', path: '/' },
      fields: [{ i: 'f0', t: 'input:text', nm: 'q' }],
      matches: (url) => url.host === 'app.chase.com',
      prefilled: () => false,
    };
    const { provider, prewarmer, nav, diags } = await setup({ pages: [bank] });
    nav.commit({ url: 'https://app.chase.com/' });
    await prewarmer.settled();
    expect(provider.calls).toBe(0);
    expect(diags.map(([, d]) => d.verdict)).toEqual(['denylisted']);
  });

  it('never fires for a host outside the registry, a sub-frame, or a non-http page, and says nothing to the popup', async () => {
    const { provider, prewarmer, nav, diags } = await setup();
    nav.commit({ url: 'https://discord.com/channels/2' });
    nav.commit({ url: 'https://example.com/' });
    nav.commit({ url: MAPS, frameId: 3 });
    nav.commit({ url: 'chrome://newtab' });
    await prewarmer.settled();
    expect(provider.calls).toBe(0);
    expect(diags).toEqual([]);
  });

  it('never fires for a host the user switched off or when carat is off', async () => {
    const off = await setup({ settings: async () => ({ ...enabled, disabledHosts: ['www.google.com'] }) });
    off.nav.commit({ url: MAPS });
    await off.prewarmer.settled();
    expect(off.provider.calls).toBe(0);
    expect(off.diags.map(([, d]) => d.verdict)).toEqual(['site-off']);

    const disabled = await setup({ settings: async () => ({ ...enabled, enabled: false }) });
    disabled.nav.commit({ url: MAPS });
    await disabled.prewarmer.settled();
    expect(disabled.provider.calls).toBe(0);
    expect(disabled.diags.map(([, d]) => d.verdict)).toEqual(['disabled']);
  });

  it('makes no call with no context, stale context, or only the navigating tab\'s own text', async () => {
    const none = await setup({ context: false });
    none.nav.commit({ url: MAPS });
    await none.prewarmer.settled();
    expect(none.provider.calls).toBe(0);
    expect(none.diags.map(([, d]) => d.verdict)).toEqual(['no-context']);

    const stale = await setup();
    stale.tick(31 * MIN);
    stale.nav.commit({ url: MAPS });
    await stale.prewarmer.settled();
    expect(stale.provider.calls).toBe(0);
    expect(stale.diags.map(([, d]) => d.verdict)).toEqual(['stale-context']);

    // The Discord text belongs to the tab that is navigating to Maps: a source for tab offers, never for fills.
    const own = await setup();
    own.nav.commit({ url: MAPS, tabId: DISCORD_TAB });
    await own.prewarmer.settled();
    expect(own.provider.calls).toBe(0);
    expect(own.diags.map(([, d]) => d.verdict)).toEqual(['own-context']);
  });

  it('caches nothing when the provider fails, so the real request still asks', async () => {
    const { store, provider, prewarmer, nav, diags } = await setup();
    provider.suggest = async () => {
      provider.calls++;
      throw new Error('boom');
    };
    nav.commit({ url: MAPS });
    await prewarmer.settled();
    expect(provider.calls).toBe(1);
    expect(diags.map(([, d]) => d.verdict)).toEqual(['failed']);
    const context = scoreAndPickContext(await store.items(), { tabId: MAPS_TAB, origin: 'https://www.google.com' }, NOW);
    expect(await store.getCached(prewarmKey('maps', context))).toBeUndefined();
    // A second commit tries again rather than trusting the failure.
    nav.commit({ url: MAPS });
    await prewarmer.settled();
    expect(provider.calls).toBe(2);
  });

  it('keeps only fills for a known field that cite the other tab, like the orchestrator would', async () => {
    const { store, provider, prewarmer, nav, ctxId } = await setup();
    provider.suggest = async () => {
      provider.calls++;
      return [
        fill({ sourceContextId: ctxId }),
        fill({ sourceContextId: ctxId, fieldId: 'f9' }),
        fill({ sourceContextId: 'someone-else' }),
        fill({ sourceContextId: ctxId, confidence: 0.5 }),
        fill({ sourceContextId: ctxId, value: '  ' }),
        { kind: 'action', intent: 'maps', value: 'x', when: '', location: '', confidence: 0.9, reason: 'r', sourceContextId: ctxId },
      ];
    };
    nav.commit({ url: MAPS });
    await prewarmer.settled();
    const context = scoreAndPickContext(await store.items(), { tabId: MAPS_TAB, origin: 'https://www.google.com' }, NOW);
    expect(await store.getCached(prewarmKey('maps', context))).toEqual([fill({ sourceContextId: ctxId })]);
  });
});

describe('lookupPrewarmed', () => {
  const live = [
    { i: 'f0', t: 'input:text', nm: 'searchboxinput', ph: 'Search Google Maps', al: 'Search Google Maps', f: 1 as const, w: 'l' as const },
    { i: 'f1', t: 'input:text', al: 'Directions from' },
  ];

  it('hands the orchestrator the warmed fill on the live field id once the real snapshot arrives', async () => {
    const { store, prewarmer, nav, ctxId } = await setup();
    nav.commit({ url: MAPS });
    await prewarmer.settled();
    const context = scoreAndPickContext(await store.items(), { tabId: MAPS_TAB, origin: 'https://www.google.com' }, NOW);
    const page = { host: 'www.google.com', title: 'Google Maps', path: '/maps/@43.4,-80.5,15z' };

    // The live snapshot numbers the box f3; the warmed fill follows it there.
    const renumbered = [{ i: 'f3', t: 'input:text', nm: 'searchboxinput', w: 'l' as const }, ...live.slice(1)];
    expect(await lookupPrewarmed(store, page, renumbered, context)).toEqual([fill({ sourceContextId: ctxId, fieldId: 'f3' })]);
    // Typed into already: nothing to adopt.
    expect(await lookupPrewarmed(store, page, [{ ...live[0]!, v: 'x' }], context)).toBeUndefined();
    // Another page, a different context pick, or a page that is not known: a miss.
    expect(await lookupPrewarmed(store, { ...page, path: '/' }, live, context)).toBeUndefined();
    expect(await lookupPrewarmed(store, page, live, [{ ...context[0]!, id: 'other' }])).toBeUndefined();
    expect(await lookupPrewarmed(store, { host: 'discord.com', title: 'Discord', path: '/' }, live, context)).toBeUndefined();
  });

  it('adopts each fill onto the first empty live field that matches its known field', () => {
    const known = KNOWN_PAGES.find((p) => p.id === 'gmail')!.fields;
    const gmail = [
      { i: 'f0', t: 'input:search', nm: 'q', al: 'Search mail' },
      { i: 'f1', t: 'combobox', nm: 'to', al: 'To recipients', nb: 'To Cc Bcc' },
      { i: 'f2', t: 'input:text', nm: 'subjectbox', al: 'Subject', v: 'Re: hi' },
    ];
    const adopted = adoptFills([fill({ fieldId: 'f0', value: 'maya@x.co' }), fill({ fieldId: 'f1', value: 'Measurements' })], known, gmail);
    expect(adopted).toEqual([fill({ fieldId: 'f1', value: 'maya@x.co' })]);
  });
});
