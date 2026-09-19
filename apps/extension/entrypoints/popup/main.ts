import { relativeAge } from '@/src/format/age';
import { sendMessage, type KnownItem } from '@/src/messaging';

const app = document.getElementById('app') as HTMLElement;
const list = document.getElementById('list') as HTMLUListElement;
const enabled = document.getElementById('enabled') as HTMLInputElement;
const clearButton = document.getElementById('clear') as HTMLButtonElement;
const pinButton = document.getElementById('pin') as HTMLButtonElement;
const pinnedNote = document.getElementById('pinned-note') as HTMLElement;
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
    const [settings, known] = await withTimeout(
      Promise.all([sendMessage('getSettings', undefined), sendMessage('getKnown', undefined)]),
    );
    enabled.checked = settings.enabled;
    renderList(known.items);
    renderPinned(known.pinned === true);
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

clearButton.addEventListener('click', async () => {
  clearButton.disabled = true;
  try {
    await withTimeout(sendMessage('clearKnown', undefined));
    renderList([]);
    // Clear wipes the whole session store, pin included.
    renderPinned(false);
  } catch {
    app.dataset.state = 'offline';
  } finally {
    clearButton.disabled = false;
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
