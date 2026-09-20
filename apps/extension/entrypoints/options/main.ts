import type { Settings } from '@carat/shared';
import { sendMessage } from '@/src/messaging';
import {
  EAGERNESS_NAMES,
  eagernessAt,
  eagernessNote,
  eagernessPosition,
  normalizeSettings,
} from './settings-form';

const app = document.getElementById('app') as HTMLElement;
const form = document.getElementById('form') as HTMLFormElement;
const status = document.getElementById('status') as HTMLElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const retryButton = document.getElementById('retry') as HTMLButtonElement;

const field = <T extends HTMLElement | RadioNodeList>(name: string) =>
  form.elements.namedItem(name) as T;

const enabled = field<HTMLInputElement>('enabled');
const provider = field<HTMLSelectElement>('provider');
const baseURL = field<HTMLInputElement>('baseURL');
const apiKey = field<HTMLInputElement>('apiKey');
const model = field<HTMLInputElement>('model');
const statusLine = field<HTMLInputElement>('statusLine');
const sound = field<HTMLInputElement>('sound');
const smartModel = field<HTMLInputElement>('smartModel');
const screenshots = field<HTMLInputElement>('screenshots');
const eagerness = field<HTMLInputElement>('eagerness');
const ghost = field<HTMLInputElement>('ghost');
const eagernessNoteEl = document.getElementById('eagerness-note') as HTMLElement;

// The thumb carries a position; everything a reader needs — the level's name
// for a screen reader, the line under the track — is derived from it here.
function showEagerness(): void {
  const level = eagernessAt(eagerness.value);
  eagerness.setAttribute('aria-valuetext', EAGERNESS_NAMES[level]);
  eagernessNoteEl.textContent = eagernessNote(eagerness.value);
}

// A fresh service worker can take a moment to wake; a dead one never answers.
// Cap the wait so the page can offer a retry instead of hanging.
function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('background timed out')), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

function render(s: Settings): void {
  enabled.checked = s.enabled;
  provider.value = s.provider;
  baseURL.value = s.baseURL;
  apiKey.value = s.apiKey;
  model.value = s.model;
  statusLine.checked = s.statusLine;
  sound.checked = s.sound;
  smartModel.value = s.smartModel;
  screenshots.checked = s.screenshots;
  ghost.checked = s.ghost;
  eagerness.value = String(eagernessPosition(s.eagerness));
  showEagerness();
}

function read(): Partial<Settings> {
  return normalizeSettings({
    enabled: enabled.checked,
    provider: provider.value,
    baseURL: baseURL.value,
    apiKey: apiKey.value,
    model: model.value,
    statusLine: statusLine.checked,
    sound: sound.checked,
    smartModel: smartModel.value,
    screenshots: screenshots.checked,
    eagerness: eagernessAt(eagerness.value),
    ghost: ghost.checked,
  });
}

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('error', error);
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
    render(await withTimeout(sendMessage('setSettings', read())));
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

eagerness.addEventListener('input', showEagerness);

retryButton.addEventListener('click', () => void load());

showEagerness();
void load();
