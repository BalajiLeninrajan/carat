import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@carat/shared';
import { createProvider, createSmartProvider } from '../src/provider';
import { OpenAICompatProvider } from '../src/openai-compat';
import { FastThenSmartProvider } from '../src/fast-then-smart';
import { JevProvider } from '../src/jev';

const cf = { cfAccountId: 'acct', cfApiToken: 'tok' };

describe('createProvider', () => {
  it('falls back to local when there is no key', () => {
    expect(createProvider({ ...DEFAULT_SETTINGS, apiKey: '' }).id).toBe('local');
  });

  it('honours an explicit local provider even with a key', () => {
    expect(createProvider({ ...DEFAULT_SETTINGS, provider: 'local', apiKey: 'sk-x' }).id).toBe('local');
  });

  it('selects openai or baseten when a key is present', () => {
    expect(createProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x' }).id).toBe('openai');
    expect(createProvider({ ...DEFAULT_SETTINGS, provider: 'baseten', apiKey: 'sk-x' }).id).toBe('baseten');
  });

  it('runs Jev alone for cloudflare without a chat key, and Jev then the chat model with one', () => {
    const alone = createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf });
    expect(alone).toBeInstanceOf(JevProvider);
    expect(alone.id).toBe('cloudflare');

    const both = createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf, apiKey: 'sk-x' });
    expect(both).toBeInstanceOf(FastThenSmartProvider);
    expect(both.id).toBe('cloudflare');
    const { fast, smart } = both as FastThenSmartProvider;
    expect(fast).toBeInstanceOf(JevProvider);
    expect((smart as OpenAICompatProvider).options.mode).toBe('json_schema');

    const other = createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf, apiKey: 'sk-x', baseURL: 'https://model.api.baseten.co/sync/v1' });
    expect(((other as FastThenSmartProvider).smart as OpenAICompatProvider).options.mode).toBe('json_object');
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
    const openai = createProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x' }, fetchImpl);
    const baseten = createProvider({ ...DEFAULT_SETTINGS, provider: 'baseten', apiKey: 'sk-x' }, fetchImpl);
    expect((openai as OpenAICompatProvider).fetchImpl).toBe(fetchImpl);
    expect((openai as OpenAICompatProvider).options.mode).toBe('json_schema');
    expect((baseten as OpenAICompatProvider).options.mode).toBe('json_object');
  });

  it('hands the injected fetch to Jev and to the chat model behind it', () => {
    const fetchImpl = (() => Promise.reject(new Error('unused'))) as unknown as typeof fetch;
    const both = createProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf, apiKey: 'sk-x' }, fetchImpl) as FastThenSmartProvider;
    expect((both.fast as JevProvider).fetchImpl).toBe(fetchImpl);
    expect((both.smart as OpenAICompatProvider).fetchImpl).toBe(fetchImpl);
  });
});

describe('createSmartProvider', () => {
  it('is undefined without a network provider: the regex fallback cannot read images', () => {
    expect(createSmartProvider({ ...DEFAULT_SETTINGS, apiKey: '' })).toBeUndefined();
    expect(createSmartProvider({ ...DEFAULT_SETTINGS, provider: 'local', apiKey: 'sk-x' })).toBeUndefined();
  });

  it('runs on the vision model, falling back to the fast model when that is blank', () => {
    const smart = createSmartProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x', model: 'fast', visionModel: 'smart' }) as OpenAICompatProvider;
    expect(smart.options.model).toBe('smart');
    expect(smart.options.mode).toBe('json_schema');
    expect(typeof smart.transcribe).toBe('function');
    const blank = createSmartProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x', model: 'fast', visionModel: '' }) as OpenAICompatProvider;
    expect(blank.options.model).toBe('fast');
  });

  it('is the chat model behind Jev for cloudflare, never Jev itself, and nothing when there is no chat key', () => {
    const smart = createSmartProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf, apiKey: 'sk-x', visionModel: 'smart' }) as OpenAICompatProvider;
    expect(smart).toBeInstanceOf(OpenAICompatProvider);
    expect(smart.options.model).toBe('smart');
    expect(smart.options.mode).toBe('json_schema');
    expect(createSmartProvider({ ...DEFAULT_SETTINGS, provider: 'cloudflare', ...cf })).toBeUndefined();
  });

  it('leaves the fast provider on the fast model', () => {
    const fast = createProvider({ ...DEFAULT_SETTINGS, apiKey: 'sk-x', model: 'fast', visionModel: 'smart' }) as OpenAICompatProvider;
    expect(fast.options.model).toBe('fast');
  });
});
