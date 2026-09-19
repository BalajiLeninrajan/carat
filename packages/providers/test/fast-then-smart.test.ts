import { describe, expect, it } from 'vitest';
import type { SuggestRequest, Suggestion } from '@carat/shared';
import { FastThenSmartProvider } from '../src/fast-then-smart';
import type { Provider } from '../src/provider';

const req: SuggestRequest = {
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' },
  fields: [{ i: 'f0', t: 'input:text', al: 'Search Google Maps' }],
  context: [{ id: 'c1', origin: 'https://discord.com', title: 'Discord', kind: 'page', text: 'dinner at Seven Shores Cafe?', capturedAt: 1 }],
  now: '2026-09-16T14:04:00-04:00',
};

const hit: Suggestion = { fieldId: 'f0', value: 'Seven Shores Cafe', confidence: 0.9, reason: 'r', sourceContextId: 'c1' };

function fake(id: Provider['id'], impl: (signal: AbortSignal) => Promise<Suggestion[]>): Provider & { calls: number } {
  const p = {
    id,
    calls: 0,
    suggest(_req: SuggestRequest, opts: { signal: AbortSignal }) {
      p.calls++;
      return impl(opts.signal);
    },
  };
  return p;
}

describe('FastThenSmartProvider', () => {
  it('returns the fast answer and never calls the smart provider', async () => {
    const fast = fake('cloudflare', async () => [hit]);
    const smart = fake('openai', async () => [{ ...hit, value: 'Other' }]);
    const out = await new FastThenSmartProvider(fast, smart).suggest(req, { signal: new AbortController().signal });
    expect(out).toEqual([hit]);
    expect(smart.calls).toBe(0);
  });

  it('calls the smart provider when the fast one returns nothing or throws', async () => {
    const smart = fake('openai', async () => [hit]);
    const empty = fake('cloudflare', async () => []);
    expect(await new FastThenSmartProvider(empty, smart).suggest(req, { signal: new AbortController().signal })).toEqual([hit]);
    const broken = fake('cloudflare', async () => {
      throw new Error('HTTP 502');
    });
    expect(await new FastThenSmartProvider(broken, smart).suggest(req, { signal: new AbortController().signal })).toEqual([hit]);
    expect(smart.calls).toBe(2);
  });

  it('takes its id from the fast provider and passes one signal to both', async () => {
    const seen: AbortSignal[] = [];
    const fast = fake('cloudflare', async (s) => {
      seen.push(s);
      return [];
    });
    const smart = fake('openai', async (s) => {
      seen.push(s);
      return [];
    });
    const p = new FastThenSmartProvider(fast, smart);
    const signal = new AbortController().signal;
    expect(p.id).toBe('cloudflare');
    await p.suggest(req, { signal });
    expect(seen).toEqual([signal, signal]);
  });

  it('stops after an abort instead of starting the smart provider', async () => {
    const controller = new AbortController();
    const fast = fake('cloudflare', async () => {
      controller.abort();
      return [];
    });
    const smart = fake('openai', async () => [hit]);
    expect(await new FastThenSmartProvider(fast, smart).suggest(req, { signal: controller.signal })).toEqual([]);
    expect(smart.calls).toBe(0);
    expect(await new FastThenSmartProvider(fast, smart).suggest(req, { signal: AbortSignal.abort() })).toEqual([]);
    expect(fast.calls).toBe(1);
  });

  it('lets a smart provider failure propagate so the orchestrator can fall back to regex', async () => {
    const fast = fake('cloudflare', async () => []);
    const smart = fake('openai', async () => {
      throw new Error('HTTP 500');
    });
    await expect(new FastThenSmartProvider(fast, smart).suggest(req, { signal: new AbortController().signal })).rejects.toThrow('HTTP 500');
  });
});
