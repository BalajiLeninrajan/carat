import type { NextAction } from '@carat/shared';
import { renderPrefix } from '@carat/shared';
import type { DebugEvent, DebugSnapshot } from '../background/debug';
import { describeNote } from '../format/diag';
import { describeEntry } from '../history';

/** What only the page knows, and the panel adds to what the background sent. */
export interface DebugExtras {
  /** The scheduler's own events, kept in the page rather than round-tripped. */
  events: DebugEvent[];
  /** The tab is in the background right now, so nothing is being asked. */
  hidden: boolean;
  /** When a Shift+Tab snooze runs out, or null when carat may speak. */
  snoozedUntil: number | null;
  now: number;
}

export interface RequestView {
  /** The outline exactly as it was sent. */
  outline: string;
  /** The `<notes>`, `<history>` and `<tabs>` blocks, byte for byte as the prefix carries them. */
  blocks: string;
  rows: Array<[string, string]>;
  /** What the copy button puts on the clipboard. */
  json: string;
}

export interface AnswerView {
  rows: Array<[string, string]>;
  /** The model's reply exactly as it streamed. */
  raw: string;
  validations: string[];
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
 * the few things only the page can answer. Pure: the panel calls it and
 * paints the result, and a test can read it without a DOM.
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
  const host = snap.gate.host || snap.diag?.suggest?.host || 'this tab';
  return `${host} · tab ${snap.tabId ?? '?'}`;
}

function requestView(snap: DebugSnapshot): RequestView | null {
  const request = snap.debug?.request;
  if (!request) return null;
  const req = request.req;
  return {
    outline: req.outline,
    blocks: renderPrefix(req),
    rows: [
      ['now', req.now],
      ['eagerness', req.eagerness],
      ['controls', String(req.controls.length)],
      ['focused', req.focused === undefined ? 'none' : `[${req.focused}]`],
      ['scroll', `${req.page.scroll.y} of ${req.page.scroll.pages} screens${req.page.scroll.more ? ', more below' : ', nothing below'}`],
      ['prompt cache key', request.promptCacheKey],
      ['answer cache key', request.cacheKey],
    ],
    json: JSON.stringify({ cacheKey: request.cacheKey, promptCacheKey: request.promptCacheKey, request: req }, null, 2),
  };
}

function answerView(snap: DebugSnapshot): AnswerView | null {
  const answer = snap.debug?.answer;
  const suggest = snap.diag?.suggest;
  if (!answer && !suggest) return null;
  const action = answer?.action ?? null;
  const rows: Array<[string, string]> = [];
  if (answer) rows.push(['placeholder', describeAction(answer.placeholder)]);
  rows.push(['kind', action?.kind ?? suggest?.kind ?? '—']);
  rows.push(['target', action ? (action.target === null ? 'none' : `[${action.target}]`) : '—']);
  rows.push(['label', action?.label ?? suggest?.label ?? '—']);
  rows.push(['confidence', num(action?.confidence ?? suggest?.confidence)]);
  rows.push(['irreversible', bool(action?.irreversible ?? suggest?.irreversible)]);
  rows.push(['reason', action?.reason || suggest?.reason || '—']);
  if (answer?.winner) rows.push(['won the race', answer.winner]);
  if (suggest?.source) rows.push(['answered first', suggest.source]);
  rows.push(['placeholder ms', num(suggest?.placeholderMs)]);
  rows.push(['first partial ms', num(suggest?.partialMs)]);
  rows.push(['final ms', num(suggest?.finalMs)]);
  rows.push(['prefix warmed', bool(suggest?.warmed)]);
  for (const a of answer?.attempts ?? suggest?.attempts ?? []) {
    rows.push([a.id, a.error ? `failed after ${a.ms} ms (${a.error})` : `${a.kind} in ${a.ms} ms`]);
  }
  if (suggest?.refused) rows.push(['refused', suggest.refused]);
  if (suggest?.reasked) rows.push(['asked again after', suggest.reasked]);
  if (suggest?.replaced) rows.push(['replaced the placeholder', 'yes']);
  // Always said when there is no chip, so "why is nothing showing" has an answer here.
  rows.push(['no chip because', suggest?.silent ?? (action || suggest?.kind ? '— (a chip went up)' : 'nothing has been asked yet')]);
  return { rows, raw: answer?.raw ?? '', validations: answer?.validations ?? [] };
}

function timeline(snap: DebugSnapshot, extras: DebugExtras): TimelineRow[] {
  const note = snap.diag?.note;
  const rows: TimelineRow[] = [
    ...snap.history.map((e) => ({ at: e.t, source: 'tab', text: describeEntry(e) })),
    // Why the page this tab last left did or did not become notes: the line
    // that answers "where did that value in the chip come from".
    ...(note ? [{ at: note.at, source: 'notes', text: describeNote(note, extras.now) }] : []),
    ...(snap.debug?.events ?? []).map(fromEvent),
    ...extras.events.map(fromEvent),
  ].map((r) => ({ ...r, when: since(r.at, extras.now) }));
  return rows.sort((a, b) => a.at - b.at);
}

function fromEvent(e: DebugEvent): { at: number; source: string; text: string } {
  return { at: e.at, source: e.source, text: e.detail ? `${e.name} — ${e.detail}` : e.name };
}

function gate(snap: DebugSnapshot, extras: DebugExtras): GateRow[] {
  const g = snap.gate;
  const left = extras.snoozedUntil === null ? 0 : Math.max(0, extras.snoozedUntil - extras.now);
  return [
    { name: 'verdict', value: g.verdict ?? 'nothing asked yet', ok: g.verdict === 'ok' || g.verdict === null },
    { name: 'enabled', value: bool(g.enabled), ok: g.enabled },
    { name: 'site on', value: `${bool(g.siteOn)} (${g.host || 'unknown host'})`, ok: g.siteOn },
    { name: 'denylisted', value: bool(g.denylisted), ok: !g.denylisted },
    { name: 'password field', value: bool(g.password), ok: !g.password },
    { name: 'snapshot present', value: bool(g.snapshot), ok: g.snapshot },
    { name: 'hidden', value: bool(extras.hidden), ok: !extras.hidden },
    { name: 'snoozed until', value: left > 0 ? `${Math.ceil(left / 1000)}s from now` : 'not snoozed', ok: left === 0 },
  ];
}

function describeAction(action: NextAction | null): string {
  if (!action) return 'nothing';
  return `${action.kind}${action.target === null ? '' : ` [${action.target}]`} "${action.label}" (${action.confidence})`;
}

function bool(v: boolean | undefined): string {
  return v === undefined ? '—' : v ? 'yes' : 'no';
}

function num(v: number | undefined): string {
  return v === undefined ? '—' : String(v);
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
