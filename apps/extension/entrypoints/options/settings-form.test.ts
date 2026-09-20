import { DEFAULT_SETTINGS, EAGERNESS_HELP, EAGERNESS_LEVELS } from '@carat/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  CLIPBOARD_PERMISSION,
  EAGERNESS_NAMES,
  eagernessAt,
  eagernessNote,
  eagernessPosition,
  normalizeSettings,
  setClipboardPermission,
} from './settings-form';

const base = { enabled: true, provider: 'openai', baseURL: '', apiKey: '', model: '', statusLine: false, sound: true, smartModel: '', screenshots: false, eagerness: 'eager', ghost: true, clipboardRead: false };

describe('normalizeSettings', () => {
  it('fills blank baseURL and model with the defaults', () => {
    const s = normalizeSettings({ ...base, baseURL: '   ', model: '' });
    expect(s.baseURL).toBe(DEFAULT_SETTINGS.baseURL);
    expect(s.model).toBe(DEFAULT_SETTINGS.model);
    expect(s.smartModel).toBe('');
    expect(DEFAULT_SETTINGS.smartModel).toBe('');
  });

  it('keeps screenshots off unless the box is ticked, and trims the smart model', () => {
    expect(normalizeSettings(base).screenshots).toBe(false);
    const s = normalizeSettings({ ...base, screenshots: true, smartModel: ' gpt-5.6 ' });
    expect(s.screenshots).toBe(true);
    expect(s.smartModel).toBe('gpt-5.6');
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
    expect(normalizeSettings({ ...base, provider: 'baseten' }).provider).toBe('baseten');
    expect(normalizeSettings({ ...base, enabled: false }).enabled).toBe(false);
  });


  it('saves the level the slider is on, whatever the thumb reports', () => {
    // The page hands normalizeSettings what the range input is on, as main.ts does.
    const atPosition = (v: string) => normalizeSettings({ ...base, eagerness: eagernessAt(v) }).eagerness;
    expect(atPosition('0')).toBe('conservative');
    expect(atPosition('1')).toBe('balanced');
    expect(atPosition('2')).toBe('eager');
    expect(atPosition('7')).toBe(DEFAULT_SETTINGS.eagerness);
    expect(atPosition('nope')).toBe(DEFAULT_SETTINGS.eagerness);
  });

  it('still rejects a level string that is not one of the three', () => {
    expect(normalizeSettings(base).eagerness).toBe('eager');
    expect(normalizeSettings({ ...base, eagerness: '' }).eagerness).toBe(DEFAULT_SETTINGS.eagerness);
    expect(normalizeSettings({ ...base, eagerness: 'Eager' }).eagerness).toBe(DEFAULT_SETTINGS.eagerness);
  });

  it('maps the slider to a level and back, and names the line under the track', () => {
    expect(EAGERNESS_LEVELS.map(eagernessPosition)).toEqual([0, 1, 2]);
    for (const level of EAGERNESS_LEVELS) {
      const position = eagernessPosition(level);
      expect(eagernessAt(position)).toBe(level);
      expect(eagernessAt(String(position))).toBe(level);
      // What the thumb moving onto that stop puts under the track and into aria-valuetext.
      expect(eagernessNote(position)).toBe(EAGERNESS_HELP[level]);
      expect(EAGERNESS_NAMES[level].toLowerCase()).toBe(level);
    }
    // Dragging left to right walks the three notes in order, longest last.
    expect([0, 1, 2].map(eagernessNote)).toEqual([
      EAGERNESS_HELP.conservative,
      EAGERNESS_HELP.balanced,
      EAGERNESS_HELP.eager,
    ]);
    // A level the slider never had still lands the thumb on the default.
    expect(eagernessPosition('reckless')).toBe(EAGERNESS_LEVELS.indexOf(DEFAULT_SETTINGS.eagerness));
  });

  it('has no payments setting to carry', () => {
    expect('allowPayments' in normalizeSettings(base)).toBe(false);
    expect('allowPayments' in DEFAULT_SETTINGS).toBe(false);
  });

  it('carries the status line toggle through', () => {
    expect(normalizeSettings(base).statusLine).toBe(false);
    expect(normalizeSettings({ ...base, statusLine: true }).statusLine).toBe(true);
  });

  it('keeps the clipboard off unless the box is ticked', () => {
    expect(normalizeSettings(base).clipboardRead).toBe(false);
    expect(normalizeSettings({ ...base, clipboardRead: true }).clipboardRead).toBe(true);
    expect(DEFAULT_SETTINGS.clipboardRead).toBe(false);
  });
});

function permissions(granted: boolean) {
  return {
    request: vi.fn(async () => granted),
    remove: vi.fn(async () => true),
  };
}

describe('the clipboard toggle', () => {
  it('asks Chrome for the permission when it goes on', async () => {
    const api = permissions(true);
    expect(await setClipboardPermission(api, true)).toBe(true);
    expect(api.request).toHaveBeenCalledWith({ permissions: [CLIPBOARD_PERMISSION] });
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('reverts when Chrome refuses', async () => {
    const api = permissions(false);
    expect(await setClipboardPermission(api, true)).toBe(false);
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it('gives the permission back when it goes off', async () => {
    const api = permissions(true);
    expect(await setClipboardPermission(api, false)).toBe(false);
    expect(api.remove).toHaveBeenCalledWith({ permissions: [CLIPBOARD_PERMISSION] });
    expect(api.request).not.toHaveBeenCalled();
  });

  it('stays off when there is no permissions API, or the call throws', async () => {
    expect(await setClipboardPermission(undefined, true)).toBe(false);
    const broken = {
      request: vi.fn(async () => {
        throw new Error('no gesture');
      }),
      remove: vi.fn(async () => true),
    };
    expect(await setClipboardPermission(broken, true)).toBe(false);
  });
});
