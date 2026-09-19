import { DEFAULT_SETTINGS } from '@carat/shared';
import { describe, expect, it } from 'vitest';
import { normalizeSettings } from './settings-form';

const base = { enabled: true, provider: 'openai', baseURL: '', apiKey: '', model: '', statusLine: false, cfAccountId: '', cfApiToken: '', visionModel: '', screenshots: false };

describe('normalizeSettings', () => {
  it('fills blank baseURL and model with the defaults', () => {
    const s = normalizeSettings({ ...base, baseURL: '   ', model: '' });
    expect(s.baseURL).toBe(DEFAULT_SETTINGS.baseURL);
    expect(s.model).toBe(DEFAULT_SETTINGS.model);
    expect(s.visionModel).toBe(DEFAULT_SETTINGS.visionModel);
  });

  it('keeps screenshots off unless the box is ticked, and trims the smart model', () => {
    expect(normalizeSettings(base).screenshots).toBe(false);
    const s = normalizeSettings({ ...base, screenshots: true, visionModel: ' gpt-5.6 ' });
    expect(s.screenshots).toBe(true);
    expect(s.visionModel).toBe('gpt-5.6');
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
    expect(normalizeSettings({ ...base, provider: 'cloudflare' }).provider).toBe('cloudflare');
    expect(normalizeSettings({ ...base, enabled: false }).enabled).toBe(false);
  });

  it('trims the Cloudflare account id and token and keeps them empty otherwise', () => {
    const s = normalizeSettings({ ...base, provider: 'cloudflare', cfAccountId: ' 0123abcd ', cfApiToken: ' cf-x ' });
    expect(s.cfAccountId).toBe('0123abcd');
    expect(s.cfApiToken).toBe('cf-x');
    expect(normalizeSettings(base).cfAccountId).toBe('');
    expect(normalizeSettings(base).cfApiToken).toBe('');
  });

  it('carries the status line toggle through', () => {
    expect(normalizeSettings(base).statusLine).toBe(false);
    expect(normalizeSettings({ ...base, statusLine: true }).statusLine).toBe(true);
  });
});
