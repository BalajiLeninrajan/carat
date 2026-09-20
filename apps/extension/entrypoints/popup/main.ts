import { sendMessage } from '@/src/messaging';
import type { Settings } from '@/src/engine/shared/settings';

const app = document.getElementById('app') as HTMLElement;
const enabled = document.getElementById('enabled') as HTMLInputElement;
const clearButton = document.getElementById('clear') as HTMLButtonElement;
const siteRow = document.getElementById('site-row') as HTMLElement;
const siteEnabled = document.getElementById('site-enabled') as HTMLInputElement;
const siteHostLabel = document.getElementById('site-host') as HTMLElement;
const modelLine = document.getElementById('model') as HTMLElement;
const pausedRow = document.getElementById('paused-row') as HTMLElement;
const resumeButton = document.getElementById('resume') as HTMLButtonElement;
const retryButton = document.getElementById('retry') as HTMLButtonElement;
const optionsLink = document.getElementById('options') as HTMLAnchorElement;

/** The host of the tab the popup was opened over; undefined on chrome:// and friends. */
let activeHost: string | undefined;
/** That tab's id, which the pause lives on. */
let activeTabId: number | undefined;

export function siteHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : undefined;
  } catch {
    return undefined;
  }
}

/** The blocklist with one host added or taken out. Read-modify-write against the latest list. */
export function withSite(settings: Settings, host: string, on: boolean): Partial<Settings> {
  const bare = host.replace(/^www\./, '');
  const without = settings.blocklist.filter((h) => h !== host && h !== bare);
  return { blocklist: on ? without : [...without, bare] };
}

export function isSiteOff(settings: Pick<Settings, 'blocklist'>, host: string): boolean {
  return settings.blocklist.some((b) => host === b || host.endsWith(`.${b}`));
}

async function findActiveTab(): Promise<{ id: number | undefined; host: string | undefined }> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { id: tab?.id, host: siteHost(tab?.url) };
  } catch {
    return { id: undefined, host: undefined };
  }
}

// A fresh service worker can take a moment to wake; a dead one never answers.
// Cap the wait so the popup can offer a retry instead of hanging.
function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('background timed out')), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

function renderSite(settings: Settings): void {
  siteRow.hidden = activeHost === undefined;
  if (activeHost === undefined) return;
  siteHostLabel.textContent = activeHost;
  siteEnabled.checked = !isSiteOff(settings, activeHost);
}

/**
 * Pressing Cancel on Chrome's debugging bar stops carat on that tab, and
 * nothing on the page says so. The popup is where the user finds out and
 * where they undo it.
 */
async function renderPaused(): Promise<void> {
  if (activeTabId === undefined) return;
  try {
    pausedRow.hidden = !(await withTimeout(sendMessage('isTabPaused', { tabId: activeTabId })));
  } catch {
    pausedRow.hidden = true;
  }
}

function renderModel(settings: Settings): void {
  modelLine.textContent = settings.apiKey
    ? `${settings.actionModel} · ghost ${settings.textModel}`
    : 'no API key yet — open Settings';
}

async function load(): Promise<void> {
  app.dataset.state = 'loading';
  enabled.disabled = true;
  try {
    const [settings, tab] = await withTimeout(Promise.all([sendMessage('getSettings', undefined), findActiveTab()]));
    activeHost = tab.host;
    activeTabId = tab.id;
    enabled.checked = settings.enabled;
    renderSite(settings);
    renderModel(settings);
    app.dataset.state = 'ready';
    void renderPaused();
  } catch {
    app.dataset.state = 'offline';
  } finally {
    enabled.disabled = false;
  }
}

enabled.addEventListener('change', async () => {
  const next = enabled.checked;
  try {
    const s = await withTimeout(sendMessage('setSettings', { enabled: next }));
    enabled.checked = s.enabled;
  } catch {
    enabled.checked = !next;
    app.dataset.state = 'offline';
  }
});

/** The three things the button can say. It is never disabled: a slow worker must not make clearing look broken. */
type ClearState = 'idle' | 'working' | 'done';
const CLEAR_LABEL = 'Clear what carat remembers';
const CLEARED_MS = 2000;
let clearedTimer: number | undefined;
let clearing = false;

function setClearState(state: ClearState): void {
  clearButton.dataset.state = state;
  clearButton.textContent = state === 'working' ? 'Clearing…' : state === 'done' ? 'Cleared' : CLEAR_LABEL;
}

clearButton.addEventListener('click', async () => {
  if (clearing) return;
  clearing = true;
  if (clearedTimer !== undefined) clearTimeout(clearedTimer);
  setClearState('working');
  try {
    await withTimeout(sendMessage('clearKnown', undefined));
    setClearState('done');
    clearedTimer = window.setTimeout(() => setClearState('idle'), CLEARED_MS);
  } catch {
    app.dataset.state = 'offline';
    setClearState('idle');
  } finally {
    clearing = false;
  }
});

siteEnabled.addEventListener('change', async () => {
  if (activeHost === undefined) return;
  const next = siteEnabled.checked;
  siteEnabled.disabled = true;
  try {
    const current = await withTimeout(sendMessage('getSettings', undefined));
    const saved = await withTimeout(sendMessage('setSettings', withSite(current, activeHost, next)));
    renderSite(saved);
  } catch {
    siteEnabled.checked = !next;
    app.dataset.state = 'offline';
  } finally {
    siteEnabled.disabled = false;
  }
});

resumeButton.addEventListener('click', async () => {
  if (activeTabId === undefined) return;
  resumeButton.disabled = true;
  try {
    await withTimeout(sendMessage('resumeTab', { tabId: activeTabId }));
    pausedRow.hidden = true;
  } catch {
    app.dataset.state = 'offline';
  } finally {
    resumeButton.disabled = false;
  }
});

retryButton.addEventListener('click', () => void load());

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void load();
