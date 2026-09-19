import type { CaptureDiag, CaptureVerdict, GateVerdict, ProviderAttempt, SuggestDiag } from '../background/diag';
import { relativeAge } from './age';

const CAPTURE: Record<CaptureVerdict, string> = {
  stored: 'stored',
  disabled: 'skipped, carat is off',
  'site-off': 'skipped, carat is off for this site',
  denylisted: 'skipped, host is on the denylist',
  pinned: 'skipped, context is pinned',
  empty: 'skipped, no text',
  'not-http': 'skipped, not an http page',
};

const GATE: Record<Exclude<GateVerdict, 'ok'>, string> = {
  disabled: 'carat is off',
  'site-off': 'carat is off for this site',
  denylisted: 'host is on the denylist',
  'no-fields': 'no empty field on the page',
  'no-context': 'nothing has been read yet',
  'own-context': 'the only context is from another tab on this site',
  'stale-context': 'all context is older than 30 min',
};

/** One line: "page from discord.com 12s ago: stored". */
export function describeCapture(d: CaptureDiag, now: number = Date.now()): string {
  return `${d.kind} from ${d.host} ${relativeAge(d.at, now)}: ${CAPTURE[d.verdict]}`;
}

/** One line: "checked 5s ago: openai answered in 812 ms with 1, offered 1". */
export function describeSuggest(d: SuggestDiag, now: number = Date.now()): string {
  const when = `checked ${relativeAge(d.at, now)}`;
  if (d.gate !== 'ok') return `${when}: no request, ${GATE[d.gate]}`;
  const outcome = d.cached
    ? 'answer from cache'
    : (d.attempts ?? []).map(describeAttempt).join('; ') || 'no provider ran';
  const tabs = d.navigation ? `, ${d.navigation} tab ${d.navigation === 1 ? 'offer' : 'offers'}` : '';
  const controls = d.interactions ? `, ${d.interactions} ${d.interactions === 1 ? 'control' : 'controls'}` : '';
  return `${when}: ${outcome}, offered ${d.offered ?? 0}${tabs}${controls}`;
}

function describeAttempt(a: ProviderAttempt): string {
  if (a.error) return `${a.id} failed after ${a.ms} ms (${a.error})`;
  return `${a.id} answered in ${a.ms} ms with ${a.count}`;
}
