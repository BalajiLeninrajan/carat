// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/src/engine/shared/settings';

const sendMessage = vi.fn();
vi.mock('@/src/messaging', () => ({ sendMessage }));

const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
const body = html.slice(html.indexOf('<main'), html.indexOf('<script'));

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const settings = { ...DEFAULT_SETTINGS, enabled: true, apiKey: 'sk-x' };

describe('popup', () => {
  beforeEach(() => {
    document.body.innerHTML = body;
    sendMessage.mockReset();
    vi.resetModules();
    vi.stubGlobal('chrome', {
      runtime: { openOptionsPage: vi.fn(async () => undefined) },
      tabs: { query: vi.fn(async () => [{ id: 7, url: 'https://calendar.google.com/calendar/u/0/r' }]) },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('locks the toggle until the background answers, then shows the models', async () => {
    const answer = deferred<typeof settings>();
    sendMessage.mockImplementation(() => answer.promise);
    await import('./main');

    const toggle = document.getElementById('enabled') as HTMLInputElement;
    const app = document.getElementById('app') as HTMLElement;
    expect(toggle.disabled).toBe(true);
    expect(app.dataset.state).toBe('loading');

    answer.resolve({ ...settings, enabled: false });
    await flush();

    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);
    expect(app.dataset.state).toBe('ready');
    expect(document.getElementById('model')?.textContent).toContain(DEFAULT_SETTINGS.actionModel);
  });

  it('says so instead of naming a model when there is no key', async () => {
    sendMessage.mockResolvedValue({ ...settings, apiKey: '' });
    await import('./main');
    await flush();
    expect(document.getElementById('model')?.textContent).toBe('no API key yet — open Settings');
  });

  it('shows the per-site row for the tab it was opened over, and blocks that host', async () => {
    sendMessage.mockResolvedValue(settings);
    await import('./main');
    await flush();

    const row = document.getElementById('site-row') as HTMLElement;
    const site = document.getElementById('site-enabled') as HTMLInputElement;
    expect(row.hidden).toBe(false);
    expect(document.getElementById('site-host')?.textContent).toBe('calendar.google.com');
    expect(site.checked).toBe(true);

    sendMessage.mockClear();
    sendMessage.mockResolvedValue({ ...settings, blocklist: ['calendar.google.com'] });
    site.checked = false;
    site.dispatchEvent(new Event('change'));
    await flush();

    const save = sendMessage.mock.calls.find(([type]) => type === 'setSettings');
    expect(save?.[1]).toEqual({ blocklist: ['calendar.google.com'] });
    expect(site.checked).toBe(false);
  });

  it('says why carat went quiet on a paused tab, and resumes it', async () => {
    sendMessage.mockImplementation(async (type: string) => (type === 'isTabPaused' ? true : settings));
    await import('./main');
    await flush();

    const row = document.getElementById('paused-row') as HTMLElement;
    expect(row.hidden).toBe(false);
    expect(row.textContent).toContain("Paused on this tab: you dismissed Chrome's debugging bar.");

    (document.getElementById('resume') as HTMLButtonElement).click();
    await flush();
    expect(sendMessage).toHaveBeenCalledWith('resumeTab', { tabId: 7 });
    expect(row.hidden).toBe(true);
  });

  it('keeps the paused line out of the way while the tab is running', async () => {
    sendMessage.mockImplementation(async (type: string) => (type === 'isTabPaused' ? false : settings));
    await import('./main');
    await flush();
    expect((document.getElementById('paused-row') as HTMLElement).hidden).toBe(true);
  });

  it('says Cleared and goes back to idle', async () => {
    vi.useFakeTimers();
    sendMessage.mockResolvedValue(settings);
    await import('./main');
    await vi.advanceTimersByTimeAsync(0);

    const clear = document.getElementById('clear') as HTMLButtonElement;
    clear.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledWith('clearKnown', undefined);
    expect(clear.dataset.state).toBe('done');
    expect(clear.textContent).toBe('Cleared');

    await vi.advanceTimersByTimeAsync(2000);
    expect(clear.dataset.state).toBe('idle');
  });

  it('loads suggestion analytics on the analytics tab', async () => {
    sendMessage.mockImplementation(async (type) => {
      if (type === 'getAnalytics') {
        return {
          enabled: true,
          window: '24h',
          totals: { key: 'all', suggested: 4, accepted: 1, dismissed: 1, alternative: 2, acceptanceRate: 25 },
          byKind: [{ key: 'open', suggested: 3, accepted: 0, dismissed: 1, alternative: 2, acceptanceRate: 0 }],
          byHost: [{ key: 'shop.example', suggested: 3, accepted: 0, dismissed: 1, alternative: 2, acceptanceRate: 0 }],
          recent: [{ at: '2026-09-20T01:00:00Z', host: 'shop.example', kind: 'open', label: 'Open AirPods', outcome: 'alternative', actual: 'clicked Back' }],
          facts: ['shop.example looks indecisive: 3 suggestions were skipped.'],
        };
      }
      return settings;
    });
    await import('./main');
    await flush();

    (document.getElementById('tab-analytics') as HTMLButtonElement).click();
    await flush();

    expect(sendMessage).toHaveBeenCalledWith('getAnalytics', undefined);
    expect(document.getElementById('analytics')?.textContent).toContain('25%');
    expect(document.getElementById('analytics')?.textContent).toContain('Open AirPods');
    expect(document.getElementById('analytics')?.textContent).toContain('indecisive');
  });

  it('goes offline when the worker never answers, and retries on demand', async () => {
    vi.useFakeTimers();
    sendMessage.mockImplementation(() => new Promise(() => undefined));
    await import('./main');
    await vi.advanceTimersByTimeAsync(3000);

    const app = document.getElementById('app') as HTMLElement;
    expect(app.dataset.state).toBe('offline');

    sendMessage.mockResolvedValue(settings);
    (document.getElementById('retry') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.dataset.state).toBe('ready');
  });

  it('puts the toggle back when saving it fails', async () => {
    vi.useFakeTimers();
    sendMessage.mockResolvedValue(settings);
    await import('./main');
    await vi.advanceTimersByTimeAsync(0);

    const toggle = document.getElementById('enabled') as HTMLInputElement;
    sendMessage.mockRejectedValue(new Error('no worker'));
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(0);
    expect(toggle.checked).toBe(true);
    expect((document.getElementById('app') as HTMLElement).dataset.state).toBe('offline');
  });
});

describe('withSite', () => {
  it('drops the www prefix and never lists a host twice', async () => {
    const { withSite, isSiteOff, siteHost } = await import('./main');
    expect(withSite({ ...settings, blocklist: [] }, 'www.a.test', false)).toEqual({ blocklist: ['a.test'] });
    expect(withSite({ ...settings, blocklist: ['a.test'] }, 'www.a.test', false)).toEqual({ blocklist: ['a.test'] });
    expect(withSite({ ...settings, blocklist: ['a.test'] }, 'www.a.test', true)).toEqual({ blocklist: [] });
    expect(isSiteOff({ blocklist: ['a.test'] }, 'sub.a.test')).toBe(true);
    expect(siteHost('chrome://extensions')).toBeUndefined();
    expect(siteHost('https://a.test/x')).toBe('a.test');
  });
});
