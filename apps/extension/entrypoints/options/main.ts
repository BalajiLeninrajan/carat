import { sendMessage } from '@/src/messaging';
import type { Settings } from '@/src/engine/shared/settings';
import { readForm, renderForm } from './form';

const app = document.getElementById('app') as HTMLElement;
const form = document.getElementById('form') as HTMLFormElement;
const status = document.getElementById('status') as HTMLElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const retryButton = document.getElementById('retry') as HTMLButtonElement;

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

retryButton.addEventListener('click', () => void load());

void load();
