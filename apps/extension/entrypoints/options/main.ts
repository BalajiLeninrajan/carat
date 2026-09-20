import { sendMessage } from '@/src/messaging';
import type { Settings } from '@/src/engine/shared/settings';
import { readForm, renderForm, setClipboardPermission } from './form';

const app = document.getElementById('app') as HTMLElement;
const form = document.getElementById('form') as HTMLFormElement;
const status = document.getElementById('status') as HTMLElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const retryButton = document.getElementById('retry') as HTMLButtonElement;
const micButton = document.getElementById('mic') as HTMLButtonElement;
const micStatus = document.getElementById('micStatus') as HTMLElement;

// A fresh service worker can take a moment to wake; a dead one never answers.
// Cap the wait so the page can offer a retry instead of hanging.
function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('background timed out')), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function render(s: Settings): void {
  renderForm(form, s);
}

async function load(): Promise<void> {
  app.dataset.state = 'loading';
  setStatus('');
  try {
    render(await withTimeout(sendMessage('getSettings', undefined)));
    app.dataset.state = 'ready';
  } catch {
    app.dataset.state = 'offline';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  saveButton.disabled = true;
  setStatus('Saving…');
  try {
    render(await withTimeout(sendMessage('setSettings', readForm(form))));
    setStatus('Saved');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'Save failed', true);
  } finally {
    saveButton.disabled = false;
  }
});

form.addEventListener('input', () => {
  if (status.textContent === 'Saved') setStatus('');
});

// Ours: the permission is asked for on the click itself, because Chrome only
// prompts during a user gesture. A refusal puts the box back, and either way
// the setting is saved at once rather than waiting for Save: the background
// drops what it read from the clipboard the moment this goes off.
const clipboardRead = form.elements.namedItem('clipboardRead') as HTMLInputElement;
clipboardRead.addEventListener('change', async () => {
  const want = clipboardRead.checked;
  const granted = await setClipboardPermission(chrome.permissions, want);
  clipboardRead.checked = granted;
  if (want && !granted) setStatus('Chrome did not grant the clipboard permission', true);
  try {
    render(await withTimeout(sendMessage('setSettings', { clipboardRead: granted })));
    if (granted === want) setStatus('Saved');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : 'Save failed', true);
  }
});

retryButton.addEventListener('click', () => void load());

/**
 * An offscreen document cannot show Chrome's microphone prompt, so the grant
 * has to be asked for from a real extension page. Once granted it holds for
 * the extension, and the worker's offscreen document opens the device without
 * asking again.
 */
micButton.addEventListener('click', async () => {
  micButton.disabled = true;
  micStatus.textContent = 'Asking…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    micStatus.textContent = 'Microphone allowed';
  } catch (err) {
    micStatus.textContent = err instanceof Error ? `Refused: ${err.message}` : 'Refused';
  } finally {
    micButton.disabled = false;
  }
});

void load();
