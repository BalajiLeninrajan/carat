import type { TabDiag } from '@/src/background/diag';
import { relativeAge } from '@/src/format/age';
import { describeCapture, describePerform, describeSuggest, describeVision } from '@/src/format/diag';
import { sendMessage, type KnownItem } from '@/src/messaging';
import { isSiteOff, siteHost, withSite } from '@/src/store/sites';

const app = document.getElementById('app') as HTMLElement;
const list = document.getElementById('list') as HTMLUListElement;
const enabled = document.getElementById('enabled') as HTMLInputElement;
const clearButton = document.getElementById('clear') as HTMLButtonElement;
const pinButton = document.getElementById('pin') as HTMLButtonElement;
const pinnedNote = document.getElementById('pinned-note') as HTMLElement;
const siteRow = document.getElementById('site-row') as HTMLElement;
const siteEnabled = document.getElementById('site-enabled') as HTMLInputElement;
const siteHostLabel = document.getElementById('site-host') as HTMLElement;
const goalRow = document.getElementById('goal-row') as HTMLElement;
const goalText = document.getElementById('goal-text') as HTMLElement;
const goalDrop = document.getElementById('goal-drop') as HTMLButtonElement;

const diagCapture = document.getElementById('diag-capture') as HTMLElement;
const diagSuggest = document.getElementById('diag-suggest') as HTMLElement;
const diagVision = document.getElementById('diag-vision') as HTMLElement;
const diagPerform = document.getElementById('diag-perform') as HTMLElement;

// The host of the tab the popup was opened over; undefined on chrome:// and friends.
let activeHost: string | undefined;

interface ActiveTab {
  id: number | undefined;
  host: string | undefined;
}

async function findActiveTab(): Promise<ActiveTab> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { id: tab?.id, host: siteHost(tab?.url) };
  } catch {
    return { id: undefined, host: undefined };
  }
}

// The debug line is a nicety; failing to get it must not take the popup offline.
async function fetchDiag(tabId: number | undefined): Promise<TabDiag | null> {
  if (tabId === undefined) return null;
  try {
    return (await withTimeout(sendMessage('getDiag', { tabId }))).diag ?? null;
  } catch {
    return null;
  }
}

function renderDiag(diag: TabDiag | null): void {
  const now = Date.now();
  diagCapture.textContent = diag?.capture ? describeCapture(diag.capture, now) : 'no capture from this tab yet';
  diagSuggest.textContent = diag?.suggest ? describeSuggest(diag.suggest, now) : 'no check on this tab yet';
  // Only says anything once a screenshot cue has come from this tab; most tabs never send one.
  diagVision.hidden = !diag?.vision;
  diagVision.textContent = diag?.vision ? describeVision(diag.vision, now) : '';
  // The last armed control pressed, or fill left half done, on this tab.
  const perform = diag?.performs?.at(-1);
  diagPerform.hidden = !perform;
  diagPerform.textContent = perform ? describePerform(perform, now) : '';
}

function renderSite(settings: { disabledHosts?: string[] }): void {
  siteRow.hidden = activeHost === undefined;
  if (activeHost === undefined) return;
  siteHostLabel.textContent = activeHost;
  // An older background answers without the list; nothing is off then.
  siteEnabled.checked = !isSiteOff({ disabledHosts: settings.disabledHosts ?? [] }, activeHost);
}
const retryButton = document.getElementById('retry') as HTMLButtonElement;
const optionsLink = document.getElementById('options') as HTMLAnchorElement;

// A fresh service worker can take a moment to wake; a dead one never answers.
// Cap the wait so the popup can offer a retry instead of hanging.
function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('background timed out')), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderItem(item: KnownItem): HTMLLIElement {
  const li = document.createElement('li');

  const meta = el('div', 'meta');
  meta.append(el('span', 'origin', item.origin.replace(/^https?:\/\//, '')));
  const chip = el('span', 'chip', item.kind);
  chip.dataset.kind = item.kind;
  meta.append(chip, el('span', 'age', relativeAge(item.capturedAt)));

  li.append(meta);
  if (item.title) li.append(el('p', 'title', item.title));
  li.append(el('p', 'preview', item.preview.slice(0, 120)));
  return li;
}

function renderList(items: KnownItem[]): void {
  list.replaceChildren(...items.map(renderItem));
  app.dataset.state = items.length === 0 ? 'empty' : 'ready';
}

/** One line for what carat thinks the user is getting done, or nothing at all. */
function renderGoal(goal: string | undefined): void {
  goalRow.hidden = !goal;
  goalText.textContent = goal ?? '';
}

function renderPinned(pinned: boolean): void {
  pinButton.textContent = pinned ? 'Unpin' : 'Pin';
  pinButton.setAttribute('aria-pressed', String(pinned));
  pinnedNote.hidden = !pinned;
}

async function load(): Promise<void> {
  app.dataset.state = 'loading';
  // Locked while loading so a click cannot be overwritten by the stale reply.
  enabled.disabled = true;
  try {
    const [settings, known, tab] = await withTimeout(
      Promise.all([sendMessage('getSettings', undefined), sendMessage('getKnown', undefined), findActiveTab()]),
    );
    activeHost = tab.host;
    enabled.checked = settings.enabled;
    renderSite(settings);
    renderList(known.items);
    renderGoal(known.goal);
    renderPinned(known.pinned === true);
    renderDiag(await fetchDiag(tab.id));
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
  // The list is this popup's copy of what carat knows; empty it as the user
  // clicks rather than after the round trip. Clear wipes the pin with the rest.
  renderList([]);
  renderGoal(undefined);
  renderPinned(false);
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

// The goal goes as the user clicks the cross; a worker that never answers
// leaves the popup offline rather than putting a dropped goal back.
goalDrop.addEventListener('click', async () => {
  renderGoal(undefined);
  try {
    await withTimeout(sendMessage('clearGoal', undefined));
  } catch {
    app.dataset.state = 'offline';
  }
});

siteEnabled.addEventListener('change', async () => {
  if (activeHost === undefined) return;
  const next = siteEnabled.checked;
  siteEnabled.disabled = true;
  try {
    // Read-modify-write against the latest list so two popups cannot clobber each other's hosts.
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

pinButton.addEventListener('click', async () => {
  const next = pinButton.getAttribute('aria-pressed') !== 'true';
  pinButton.disabled = true;
  try {
    const res = await withTimeout(sendMessage('setPinned', { pinned: next }));
    renderPinned(res.pinned);
  } catch {
    app.dataset.state = 'offline';
  } finally {
    pinButton.disabled = false;
  }
});

retryButton.addEventListener('click', () => void load());

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void load();
