// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn();
vi.mock('@/src/messaging', () => ({ sendMessage }));

const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
const body = html.slice(html.indexOf('<main'), html.indexOf('<script'));

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

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

  it('locks the toggle until the background answers, then renders items', async () => {
    const settings = deferred<{ enabled: boolean }>();
    const known = deferred<{ items: unknown[] }>();
    sendMessage.mockImplementation((type: string) =>
      type === 'getSettings' ? settings.promise : known.promise,
    );
    await import('./main');

    const toggle = document.getElementById('enabled') as HTMLInputElement;
    const app = document.getElementById('app') as HTMLElement;
    expect(toggle.disabled).toBe(true);
    expect(app.dataset.state).toBe('loading');

    settings.resolve({ enabled: false });
    known.resolve({
      items: [
        {
          id: 'a',
          origin: 'https://discord.com',
          title: 'general',
          kind: 'page',
          capturedAt: Date.now() - 5000,
          preview: 'x'.repeat(200),
        },
      ],
    });
    await flush();

    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);
    expect(app.dataset.state).toBe('ready');
    const li = document.querySelector('#list li') as HTMLLIElement;
    expect(li.querySelector('.origin')?.textContent).toBe('discord.com');
    expect(li.querySelector('.chip')?.textContent).toBe('page');
    expect(li.querySelector('.age')?.textContent).toBe('just now');
    expect(li.querySelector('.preview')?.textContent).toHaveLength(120);
  });

  it('shows the empty state and clears', async () => {
    sendMessage.mockImplementation(async (type: string) =>
      type === 'getSettings' ? { enabled: true } : type === 'getKnown' ? { items: [] } : undefined,
    );
    await import('./main');
    await flush();
    const app = document.getElementById('app') as HTMLElement;
    expect(app.dataset.state).toBe('empty');

    (document.getElementById('clear') as HTMLButtonElement).click();
    await flush();
    expect(sendMessage).toHaveBeenCalledWith('clearKnown', undefined);
    expect(app.dataset.state).toBe('empty');
  });

  it('clears from the header: the list empties as you click, the button says so, and it never locks', async () => {
    vi.useFakeTimers();
    const wiped = deferred<undefined>();
    sendMessage.mockImplementation((type: string) => {
      if (type === 'getSettings') return Promise.resolve({ enabled: true });
      if (type === 'getKnown') {
        return Promise.resolve({
          items: [{ id: 'a', origin: 'https://discord.com', title: 'general', kind: 'page', capturedAt: Date.now(), preview: 'dinner?' }],
          pinned: true,
        });
      }
      if (type === 'clearKnown') return wiped.promise;
      return Promise.resolve(undefined);
    });
    await import('./main');
    await vi.advanceTimersByTimeAsync(0);
    const app = document.getElementById('app') as HTMLElement;
    const clear = document.getElementById('clear') as HTMLButtonElement;
    // At the top of the popup, beside the on switch, rather than tucked in the footer.
    expect(clear.closest('header')).not.toBeNull();
    expect(clear.textContent).toBe('Clear what carat remembers');
    expect(document.querySelectorAll('#list li')).toHaveLength(1);

    clear.click();
    expect(document.querySelectorAll('#list li')).toHaveLength(0);
    expect(app.dataset.state).toBe('empty');
    expect((document.getElementById('pinned-note') as HTMLElement).hidden).toBe(true);
    // The worker is still thinking, and the button still says what it is doing.
    expect(clear.textContent).toBe('Clearing…');
    expect(clear.disabled).toBe(false);

    wiped.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledWith('clearKnown', undefined);
    expect(clear.textContent).toBe('Cleared');

    await vi.advanceTimersByTimeAsync(2000);
    expect(clear.textContent).toBe('Clear what carat remembers');
  });

  it('says the worker is offline when a clear times out, and takes the label back', async () => {
    vi.useFakeTimers();
    sendMessage.mockImplementation((type: string) =>
      type === 'clearKnown' ? new Promise(() => {}) : Promise.resolve(type === 'getSettings' ? { enabled: true } : { items: [] }),
    );
    await import('./main');
    await vi.advanceTimersByTimeAsync(0);
    const clear = document.getElementById('clear') as HTMLButtonElement;
    clear.click();
    await vi.advanceTimersByTimeAsync(3001);
    expect((document.getElementById('app') as HTMLElement).dataset.state).toBe('offline');
    expect(clear.textContent).toBe('Clear what carat remembers');
  });

  it('flips to offline when the background hangs, and retries', async () => {
    vi.useFakeTimers();
    sendMessage.mockImplementation(() => new Promise(() => {}));
    await import('./main');
    await vi.advanceTimersByTimeAsync(3001);
    const app = document.getElementById('app') as HTMLElement;
    expect(app.dataset.state).toBe('offline');
    expect((document.getElementById('enabled') as HTMLInputElement).disabled).toBe(false);

    sendMessage.mockImplementation(async (type: string) =>
      type === 'getSettings' ? { enabled: true } : { items: [] },
    );
    (document.getElementById('retry') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.dataset.state).toBe('empty');
  });

  it('reverts the toggle when setSettings fails', async () => {
    sendMessage.mockImplementation(async (type: string) => {
      if (type === 'getSettings') return { enabled: true };
      if (type === 'getKnown') return { items: [] };
      throw new Error('no receiver');
    });
    await import('./main');
    await flush();
    const toggle = document.getElementById('enabled') as HTMLInputElement;
    toggle.click();
    expect(toggle.checked).toBe(false);
    await flush();
    expect(toggle.checked).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith('setSettings', { enabled: false });
  });

  it('switches carat off and on for the active tab host', async () => {
    let settings = { enabled: true, disabledHosts: ['discord.com'] };
    sendMessage.mockImplementation(async (type: string, data?: Partial<typeof settings>) => {
      if (type === 'getSettings') return settings;
      if (type === 'getKnown') return { items: [], pinned: false };
      if (type === 'setSettings') {
        settings = { ...settings, ...data };
        return settings;
      }
      return undefined;
    });
    await import('./main');
    await flush();
    const row = document.getElementById('site-row') as HTMLElement;
    const box = document.getElementById('site-enabled') as HTMLInputElement;
    expect(row.hidden).toBe(false);
    expect(document.getElementById('site-host')?.textContent).toBe('calendar.google.com');
    expect(box.checked).toBe(true);

    box.click();
    await flush();
    expect(sendMessage).toHaveBeenCalledWith('setSettings', { disabledHosts: ['discord.com', 'calendar.google.com'] });
    expect(box.checked).toBe(false);

    box.click();
    await flush();
    expect(sendMessage).toHaveBeenLastCalledWith('setSettings', { disabledHosts: ['discord.com'] });
    expect(box.checked).toBe(true);
  });

  it('shows the last capture and check for the active tab', async () => {
    const now = Date.now();
    sendMessage.mockImplementation(async (type: string, data?: { tabId?: number }) => {
      if (type === 'getSettings') return { enabled: true, disabledHosts: [] };
      if (type === 'getKnown') return { items: [], pinned: false };
      if (type === 'getDiag' && data?.tabId === 7) {
        return {
          diag: {
            capture: { at: now - 12_000, host: 'calendar.google.com', kind: 'page', verdict: 'stored' },
            suggest: { at: now - 15_000, host: 'calendar.google.com', fields: 3, gate: 'no-snapshot' },
          },
        };
      }
      return undefined;
    });
    await import('./main');
    await flush();
    expect(document.getElementById('diag-capture')?.textContent).toBe('page from calendar.google.com 12s ago: stored');
    expect(document.getElementById('diag-suggest')?.textContent).toBe(
      'checked 15s ago: no request, nothing on the page to act on',
    );
  });

  it('keeps the popup up when the debug line cannot be fetched', async () => {
    sendMessage.mockImplementation(async (type: string) => {
      if (type === 'getSettings') return { enabled: true, disabledHosts: [] };
      if (type === 'getKnown') return { items: [], pinned: false };
      throw new Error('no diag');
    });
    await import('./main');
    await flush();
    expect((document.getElementById('app') as HTMLElement).dataset.state).toBe('empty');
    expect(document.getElementById('diag-suggest')?.textContent).toBe('no check on this tab yet');
  });

  it('hides the site switch over a page carat cannot run on', async () => {
    (chrome.tabs.query as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ url: 'chrome://extensions' }]);
    sendMessage.mockImplementation(async (type: string) =>
      type === 'getSettings' ? { enabled: true, disabledHosts: [] } : { items: [], pinned: false },
    );
    await import('./main');
    await flush();
    expect((document.getElementById('site-row') as HTMLElement).hidden).toBe(true);
  });

  it('pins and unpins the store from the footer, and Clear unpins', async () => {
    let pinned = false;
    sendMessage.mockImplementation(async (type: string, data?: { pinned?: boolean }) => {
      if (type === 'getSettings') return { enabled: true };
      if (type === 'getKnown') return { items: [], pinned };
      if (type === 'setPinned') {
        pinned = data!.pinned!;
        return { pinned };
      }
      return undefined;
    });
    await import('./main');
    await flush();
    const pin = document.getElementById('pin') as HTMLButtonElement;
    const note = document.getElementById('pinned-note') as HTMLElement;
    expect(pin.textContent).toBe('Pin');
    expect(note.hidden).toBe(true);

    pin.click();
    await flush();
    expect(sendMessage).toHaveBeenCalledWith('setPinned', { pinned: true });
    expect(pin.textContent).toBe('Unpin');
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    expect(note.hidden).toBe(false);

    (document.getElementById('clear') as HTMLButtonElement).click();
    await flush();
    expect(pin.textContent).toBe('Pin');
    expect(note.hidden).toBe(true);
  });

  it('opens the options page from the Settings link', async () => {
    sendMessage.mockImplementation(async (type: string) =>
      type === 'getSettings' ? { enabled: true } : { items: [] },
    );
    await import('./main');
    (document.getElementById('options') as HTMLAnchorElement).click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
  });
});
