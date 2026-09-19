import { describe, expect, it } from 'vitest';
import type { Settings } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
import { createProvider, createSmartProvider } from '../src/provider';
import { OpenAICompatProvider } from '../src/openai-compat';
import { RaceProvider } from '../src/race';
import { JevProvider } from '../src/jev';
import { LocalProvider } from '../src/local';

const cf = { cfAccountId: 'acct', cfApiToken: 'tok' };

/** The sources a race was built from, by class. */
function inside<T>(p: unknown, cls: new (...args: never[]) => T): T {
  expect(p).toBeInstanceOf(RaceProvider);
  const found = (p as RaceProvider).providers.find((x) => x instanceof cls);
  expect(found).toBeInstanceOf(cls);
  return found as T;
}

describe('createProvider', () => {
  it('hands the eagerness setting to whichever provider it builds', () => {
    expect((createProvider({ ...DEFAULT_SETTINGS, provider: 'local', eagerness: 'balanced' }) as LocalProvider).eagerness).toBe('balanced');
    expect((createProvider({ ...DEFAULT_SETTINGS, apiKey: '' }) as LocalProvider).eagerness).toBe('eager');
    expect(inside(createProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x', eagerness: 'conservative' }), OpenAICompatProvider).options.eagerness).toBe('conservative');
    const both = createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf, apiKey: 'sk-x', eagerness: 'balanced' });
    expect(inside(both, LocalProvider).eagerness).toBe('balanced');
    expect(inside(both, JevProvider).options.eagerness).toBe('balanced');
    expect(inside(both, OpenAICompatProvider).options.eagerness).toBe('balanced');
    expect((createSmartProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x', eagerness: 'conservative' }) as OpenAICompatProvider).options.eagerness).toBe('conservative');
  });

  it('falls back to local when there is no key', () => {
    const p = createProvider({ ...DEFAULT_SETTINGS, apiKey: '' });
    expect(p.id).toBe('local');
    expect(p).toBeInstanceOf(LocalProvider);
  });

  it('honours an explicit local provider even with a key', () => {
    expect(createProvider({ ...DEFAULT_SETTINGS, provider: 'local', apiKey: 'sk-x' }).id).toBe('local');
  });

  it('races regex against openai or baseten when a key is present', () => {
    const openai = createProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x' });
    expect(openai.id).toBe('openai');
    expect((openai as RaceProvider).providers.map((p) => p.constructor)).toEqual([LocalProvider, OpenAICompatProvider]);
    expect(createProvider({ ...DEFAULT_SETTINGS, provider: 'baseten', apiKey: 'sk-x' }).id).toBe('baseten');
  });

  it('races regex and Jev for cloudflare without a chat key, and the chat model too with one', () => {
    const alone = createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf });
    expect(alone.id).toBe('cloudflare');
    expect((alone as RaceProvider).providers.map((p) => p.constructor)).toEqual([LocalProvider, JevProvider]);

    const both = createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf, apiKey: 'sk-x' });
    expect(both.id).toBe('cloudflare');
    // Start order is rank on a tie: the chat model last, so it wins one.
    expect((both as RaceProvider).providers.map((p) => p.constructor)).toEqual([LocalProvider, JevProvider, OpenAICompatProvider]);
    expect(inside(both, OpenAICompatProvider).options.mode).toBe('json_schema');

    const other = createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf, apiKey: 'sk-x', baseURL: 'https://model.api.baseten.co/sync/v1' });
    expect(inside(other, OpenAICompatProvider).options.mode).toBe('json_object');
  });

  it('treats cloudflare without an account id or token like openai', () => {
    expect(createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare' }).id).toBe('local');
    expect(createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', cfAccountId: 'acct' }).id).toBe('local');
    expect(createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', apiKey: 'sk-x' }).id).toBe('openai');
  });
});

describe('createProvider transport', () => {
  it('hands the injected fetch and defaults to the OpenAI-compatible modes', () => {
    const fetchImpl = (() => Promise.reject(new Error('unused'))) as unknown as typeof fetch;
    const openai = inside(createProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x' }, fetchImpl), OpenAICompatProvider);
    const baseten = inside(createProvider({ ...DEFAULT_SETTINGS, provider: 'baseten', apiKey: 'sk-x' }, fetchImpl), OpenAICompatProvider);
    expect(openai.fetchImpl).toBe(fetchImpl);
    expect(openai.options.mode).toBe('json_schema');
    expect(baseten.options.mode).toBe('json_object');
  });

  it('hands the injected fetch to Jev and to the chat model behind it', () => {
    const fetchImpl = (() => Promise.reject(new Error('unused'))) as unknown as typeof fetch;
    const both = createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf, apiKey: 'sk-x' }, fetchImpl);
    expect(inside(both, JevProvider).fetchImpl).toBe(fetchImpl);
    expect(inside(both, OpenAICompatProvider).fetchImpl).toBe(fetchImpl);
  });
});

describe('createSmartProvider', () => {
  it('is undefined without a network provider: the regex fallback cannot read images', () => {
    expect(createSmartProvider({ ...DEFAULT_SETTINGS, apiKey: '' })).toBeUndefined();
    expect(createSmartProvider({ ...DEFAULT_SETTINGS, provider: 'local', apiKey: 'sk-x' })).toBeUndefined();
  });

  it('runs on the fast model by default, on smartModel when one is set', () => {
    const byDefault = createSmartProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x' }) as OpenAICompatProvider;
    expect(DEFAULT_SETTINGS.smartModel).toBe('');
    expect(byDefault.options.model).toBe(DEFAULT_SETTINGS.model);
    const smart = createSmartProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x', model: 'fast', smartModel: 'smart' }) as OpenAICompatProvider;
    expect(smart.options.model).toBe('smart');
    expect(smart.options.mode).toBe('json_schema');
    expect(typeof smart.transcribe).toBe('function');
  });

  it('asks OpenAI for no reasoning on the fast path and a little on the smart path, and asks other servers for nothing', () => {
    const openai = { ...DEFAULT_SETTINGS, apiKey: 'sk-x' };
    const fast = inside(createProvider(openai), OpenAICompatProvider);
    const smart = createSmartProvider(openai) as OpenAICompatProvider;
    expect(fast.options.reasoningEffort).toBe('none');
    expect(smart.options.reasoningEffort).toBe('low');
    // Same model, different effort: that is the whole difference between the two passes by default.
    expect(smart.options.model).toBe(fast.options.model);

    const baseten: Settings = { ...openai, provider: 'baseten', baseURL: 'https://model.api.baseten.co/sync/v1' };
    expect(inside(createProvider(baseten), OpenAICompatProvider).options.reasoningEffort).toBeUndefined();
    expect((createSmartProvider(baseten) as OpenAICompatProvider).options.reasoningEffort).toBeUndefined();
    // A proxy under the openai setting is not api.openai.com either.
    const proxy: Settings = { ...openai, baseURL: 'https://proxy.example/v1' };
    expect(inside(createProvider(proxy), OpenAICompatProvider).options.reasoningEffort).toBeUndefined();
  });

  it('is the chat model behind Jev for cloudflare, never Jev itself, and nothing when there is no chat key', () => {
    const smart = createSmartProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf, apiKey: 'sk-x', smartModel: 'smart' }) as OpenAICompatProvider;
    expect(smart).toBeInstanceOf(OpenAICompatProvider);
    expect(smart.options.model).toBe('smart');
    expect(smart.options.mode).toBe('json_schema');
    expect(createSmartProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf })).toBeUndefined();
  });

  it('leaves the fast provider on the fast model', () => {
    const fast = inside(createProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x', model: 'fast', smartModel: 'smart' }), OpenAICompatProvider);
    expect(fast.options.model).toBe('fast');
  });
});
