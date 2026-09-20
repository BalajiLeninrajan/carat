import type { DebugEvent, DebugSnapshot } from './log';

/** What only the page knows, and the panel adds to what the background sent. */
export interface DebugExtras {
  /** The content script's own events, kept in the page rather than round-tripped. */
  events: DebugEvent[];
  /** The tab is in the background right now, so nothing is being asked. */
  hidden: boolean;
  now: number;
}

export interface RequestView {
  /** The `<page>`, `<browser>`, `<notes>` and `<history>` blocks, byte for byte as they went out. */
  blocks: string;
  rows: Array<[string, string]>;
  /** What the copy button puts on the clipboard. */
  json: string;
}

export interface AnswerView {
  rows: Array<[string, string]>;
  /** The model's reply exactly as it streamed. */
  raw: string;
}

export interface TimelineRow {
  at: number;
  when: string;
  source: string;
  text: string;
}

export interface GateRow {
  name: string;
  value: string;
  /** Whether this precondition is letting requests through. */
  ok: boolean;
}

export interface DebugView {
  head: string;
  request: RequestView | null;
  answer: AnswerView | null;
  timeline: TimelineRow[];
  gate: GateRow[];
}

/**
 * Everything the panel draws, from the background's snapshot of the tab and
 * the few things only the page can answer. Pure: the panel calls it and paints
 * the result, and a test can read it without a DOM.
 */
export function debugView(snap: DebugSnapshot, extras: DebugExtras): DebugView {
  return {
    head: head(snap),
    request: requestView(snap),
    answer: answerView(snap),
    timeline: timeline(snap, extras),
    gate: gate(snap, extras),
  };
}

function head(snap: DebugSnapshot): string {
  return `${snap.gate.host || 'this tab'} · tab ${snap.tabId ?? '?'}`;
}

function requestView(snap: DebugSnapshot): RequestView | null {
  const request = snap.debug?.request;
  if (!request) return null;
  return {
    blocks: request.userTurn,
    rows: [
      ['model', request.model],
      ['numbered controls', String(request.candidates)],
      ['user turn', `${request.userTurn.length} chars`],
      ['prompt cache key', request.promptCacheKey || '—'],
    ],
    json: request.json,
  };
}

function answerView(snap: DebugSnapshot): AnswerView | null {
  const answer = snap.debug?.answer;
  if (!answer) return null;
  return {
    rows: [
      ['kind', answer.kind ?? '—'],
      ['target', answer.target === null ? 'none' : `[${answer.target}]`],
      ['label', answer.label || '—'],
      ['value', answer.value || '—'],
      ['irreversible', bool(answer.irreversible)],
      ['outcome', answer.outcome],
      ['first token ms', num(answer.ttftMs)],
      ['ring ms', num(answer.targetMs)],
      ['total ms', num(answer.totalMs)],
      ['tokens', answer.usage ? `${answer.usage.input} in (${answer.usage.cached} cached) / ${answer.usage.output} out` : '—'],
    ],
    raw: answer.raw,
  };
}

function timeline(snap: DebugSnapshot, extras: DebugExtras): TimelineRow[] {
  const rows = [...(snap.debug?.events ?? []), ...extras.events]
    .map((e) => ({ at: e.at, source: e.source as string, text: e.detail ? `${e.name} — ${e.detail}` : e.name }))
    .map((r) => ({ ...r, when: since(r.at, extras.now) }));
  return rows.sort((a, b) => a.at - b.at);
}

function gate(snap: DebugSnapshot, extras: DebugExtras): GateRow[] {
  const g = snap.gate;
  return [
    { name: 'enabled', value: bool(g.enabled), ok: g.enabled },
    { name: 'site allowed', value: `${bool(!g.blocked)} (${g.host || 'unknown host'})`, ok: !g.blocked },
    { name: 'api key set', value: bool(g.keySet), ok: g.keySet },
    { name: 'debugger attached', value: g.paused ? 'no (you dismissed the banner)' : 'yes', ok: !g.paused },
    { name: 'hidden', value: bool(extras.hidden), ok: !extras.hidden },
  ];
}

/** The engine's own history lines for this tab, exactly as the prompt carries them. */
export function historyBlock(snap: DebugSnapshot): string {
  return snap.history;
}

function bool(v: boolean | undefined): string {
  return v === undefined ? '—' : v ? 'yes' : 'no';
}

function num(v: number | null | undefined): string {
  return v === undefined || v === null ? '—' : String(v);
}

/** How long ago, relative to the panel's last paint: `-12.3s`, `-2m04s`. */
export function since(at: number, now: number): string {
  const ms = now - at;
  if (ms < 0) return '+0.0s';
  const seconds = ms / 1000;
  if (seconds < 60) return `-${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `-${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
}
