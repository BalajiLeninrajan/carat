import { DEFAULT_SETTINGS } from '@carat/shared';
import { describe, expect, it } from 'vitest';
import { normalizeSettings } from './settings-form';

const base = { enabled: true, provider: 'openai', baseURL: '', apiKey: '', model: '', statusLine: false };

describe('normalizeSettings', () => {
  it('fills blank baseURL and model with the defaults', () => {
    const s = normalizeSettings({ ...base, baseURL: '   ', model: '' });
    expect(s.baseURL).toBe(DEFAULT_SETTINGS.baseURL);
    expect(s.model).toBe(DEFAULT_SETTINGS.model);
  });

  it('strips trailing slashes and surrounding whitespace', () => {
    const s = normalizeSettings({
      ...base,
      baseURL: ' https://model.api.baseten.co/sync/v1// ',
      apiKey: ' sk-x ',
      model: ' gpt-5-mini ',
    });
    expect(s.baseURL).toBe('https://model.api.baseten.co/sync/v1');
    expect(s.apiKey).toBe('sk-x');
    expect(s.model).toBe('gpt-5-mini');
  });

  it('keeps an empty key empty so the local fallback is used', () => {
    expect(normalizeSettings(base).apiKey).toBe('');
  });

  it('rejects unknown providers', () => {
    expect(normalizeSettings({ ...base, provider: 'anthropic' }).provider).toBe(
      DEFAULT_SETTINGS.provider,
    );
    expect(normalizeSettings({ ...base, provider: 'local' }).provider).toBe('local');
    expect(normalizeSettings({ ...base, enabled: false }).enabled).toBe(false);
  });

  it('carries the status line toggle through', () => {
    expect(normalizeSettings(base).statusLine).toBe(false);
    expect(normalizeSettings({ ...base, statusLine: true }).statusLine).toBe(true);
  });
});
