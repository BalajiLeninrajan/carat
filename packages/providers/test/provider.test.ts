import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@carat/shared';
import { createProvider } from '../src/provider';
import type { OpenAICompatProvider } from '../src/openai-compat';

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
});
