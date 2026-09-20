import type { Settings } from '@carat/shared';
import type { ElasticDebugEvent, ElasticDebugKind } from '@/src/background/elastic';
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
const elasticKind = document.getElementById('elastic-kind') as HTMLSelectElement;
const elasticRefresh = document.getElementById('elastic-refresh') as HTMLButtonElement;
const elasticClear = document.getElementById('elastic-clear') as HTMLButtonElement;
const elasticSummary = document.getElementById('elastic-summary') as HTMLElement;
const elasticEvents = document.getElementById('elastic-events') as HTMLElement;

const field = <T extends HTMLElement | RadioNodeList>(name: string) =>
  form.elements.namedItem(name) as T;

const enabled = field<HTMLInputElement>('enabled');
const provider = field<HTMLSelectElement>('provider');
const baseURL = field<HTMLInputElement>('baseURL');
const apiKey = field<HTMLInputElement>('apiKey');
const model = field<HTMLInputElement>('model');
const statusLine = field<HTMLInputElement>('statusLine');
const cfAccountId = field<HTMLInputElement>('cfAccountId');
const cfApiToken = field<HTMLInputElement>('cfApiToken');
const smartModel = field<HTMLInputElement>('smartModel');
const elasticUrl = field<HTMLInputElement>('elasticUrl');
const elasticApiKey = field<HTMLInputElement>('elasticApiKey');
const elasticIndexPrefix = field<HTMLInputElement>('elasticIndexPrefix');
const elasticInferenceId = field<HTMLInputElement>('elasticInferenceId');
const screenshots = field<HTMLInputElement>('screenshots');
const eagerness = field<HTMLInputElement>('eagerness');
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

function render(s: Partial<Settings>): void {
  enabled.checked = s.enabled ?? true;
  provider.value = text(s.provider, 'openai');
  baseURL.value = text(s.baseURL, '');
  apiKey.value = text(s.apiKey, '');
  model.value = text(s.model, '');
  statusLine.checked = s.statusLine ?? false;
  cfAccountId.value = text(s.cfAccountId, '');
  cfApiToken.value = text(s.cfApiToken, '');
  smartModel.value = text(s.smartModel, '');
  elasticUrl.value = text(s.elasticUrl, '');
  elasticApiKey.value = text(s.elasticApiKey, '');
  elasticIndexPrefix.value = text(s.elasticIndexPrefix, 'carat');
  elasticInferenceId.value = text(s.elasticInferenceId, '');
  screenshots.checked = s.screenshots ?? false;
  eagerness.value = String(eagernessPosition(s.eagerness ?? 'balanced'));
  showEagerness();
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== 'undefined' && value !== 'null' ? value : fallback;
}

function read(): Partial<Settings> {
  return normalizeSettings({
    enabled: enabled.checked,
    provider: provider.value,
    baseURL: baseURL.value,
    apiKey: apiKey.value,
    model: model.value,
    statusLine: statusLine.checked,
    cfAccountId: cfAccountId.value,
    cfApiToken: cfApiToken.value,
    smartModel: smartModel.value,
    elasticUrl: elasticUrl.value,
    elasticApiKey: elasticApiKey.value,
    elasticIndexPrefix: elasticIndexPrefix.value,
    elasticInferenceId: elasticInferenceId.value,
    screenshots: screenshots.checked,
    eagerness: eagernessAt(eagerness.value),
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
    await loadElasticDashboard();
    app.dataset.state = 'ready';
  } catch {
    app.dataset.state = 'offline';
  }
}

async function loadElasticDashboard(): Promise<void> {
  const kind = elasticKind.value as ElasticDebugKind | 'all';
  elasticRefresh.disabled = true;
  try {
    const res = await withTimeout(sendMessage('getElasticDebug', { kind, limit: 100 }));
    renderElasticDashboard(res.events);
  } catch {
    renderElasticDashboard([]);
  } finally {
    elasticRefresh.disabled = false;
  }
}

function renderElasticDashboard(events: ElasticDebugEvent[]): void {
  elasticSummary.replaceChildren(...summaryMetrics(events));
  if (events.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-log';
    empty.textContent = 'No Elastic calls in this session yet. Capture a page, leave it so facts distill, or ask for a next action to generate indexing and search logs.';
    elasticEvents.replaceChildren(empty);
    return;
  }
  elasticEvents.replaceChildren(...events.slice().reverse().map(renderElasticEvent));
}

function summaryMetrics(events: ElasticDebugEvent[]): HTMLElement[] {
  const counts = {
    total: events.length,
    failed: events.filter((e) => !e.ok).length,
    writes: events.filter((e) => e.kind === 'index').length,
    searches: events.filter((e) => e.kind === 'search').length,
    bm25: events.filter((e) => e.kind === 'search' && queryMode(e) === 'BM25').length,
    hybrid: events.filter((e) => e.kind === 'search' && queryMode(e) === 'Hybrid RRF').length,
  };
  return [
    metric('events', counts.total),
    metric('failed', counts.failed),
    metric('index uploads', counts.writes),
    metric('searches', counts.searches),
    metric('BM25', counts.bm25),
    metric('hybrid', counts.hybrid),
  ];
}

function metric(label: string, value: number): HTMLElement {
  const node = document.createElement('span');
  node.className = 'metric';
  const strong = document.createElement('strong');
  strong.textContent = String(value);
  node.append(strong, ` ${label}`);
  return node;
}

function renderElasticEvent(event: ElasticDebugEvent): HTMLElement {
  const row = document.createElement('details');
  row.className = 'event';
  const summary = document.createElement('summary');
  const time = document.createElement('span');
  time.textContent = new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const kind = badge(event.kind);
  const status = badge(event.ok ? `ok${event.status ? ` ${event.status}` : ''}` : `fail${event.status ? ` ${event.status}` : ''}`, !event.ok);
  const title = document.createElement('span');
  title.className = 'event-title';
  title.textContent = `${event.summary} · ${eventLabel(event)}`;
  summary.append(time, kind, status, title);

  const body = document.createElement('div');
  body.className = 'event-body';
  const path = document.createElement('div');
  path.className = 'event-path';
  path.textContent = event.path;
  body.append(path, jsonBlock('request', event.request), jsonBlock('response', event.response));
  row.append(summary, body);
  return row;
}

function badge(text: string, fail = false): HTMLElement {
  const node = document.createElement('span');
  node.className = `badge${fail ? ' fail' : ''}`;
  node.textContent = text;
  return node;
}

function jsonBlock(title: string, value: unknown): HTMLElement {
  const wrap = document.createElement('div');
  const h = document.createElement('h3');
  h.textContent = title;
  const pre = document.createElement('pre');
  pre.textContent = formatJson(value);
  wrap.append(h, pre);
  return wrap;
}

function formatJson(value: unknown): string {
  if (value === undefined) return '(none)';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function eventLabel(event: ElasticDebugEvent): string {
  if (event.kind === 'index') return indexTarget(event.path);
  if (event.kind === 'search') return queryMode(event);
  if (event.kind === 'mapping') return 'index mapping';
  if (event.kind === 'pipeline') return 'ingest pipeline';
  if (event.kind === 'cleanup') return 'delete by query';
  return 'aggregation';
}

function indexTarget(path: string): string {
  const match = /^\/([^/]+)\/_doc\//.exec(path);
  return match ? `upload to ${decodeURIComponent(match[1]!)}` : 'index upload';
}

function queryMode(event: ElasticDebugEvent): string {
  const request = event.request as { retriever?: unknown; query?: unknown; sort?: unknown; _source?: unknown } | undefined;
  if (!request || typeof request !== 'object') return 'search';
  if (request.retriever) return 'Hybrid RRF';
  if (Array.isArray(request.sort)) return 'latest task pool';
  if (request.query) return 'BM25';
  return 'search';
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

elasticRefresh.addEventListener('click', () => void loadElasticDashboard());
elasticKind.addEventListener('change', () => void loadElasticDashboard());
elasticClear.addEventListener('click', async () => {
  elasticClear.disabled = true;
  try {
    await withTimeout(sendMessage('clearElasticDebug', undefined));
    renderElasticDashboard([]);
  } finally {
    elasticClear.disabled = false;
  }
});

showEagerness();
void load();
