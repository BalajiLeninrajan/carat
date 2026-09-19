import { DEFAULT_EAGERNESS, EAGERNESS } from '@carat/shared';
import type { AnswerOrigin, CaptureDiag, CaptureVerdict, GateVerdict, PerformDiag, ProviderAttempt, SuggestDiag, VisionDiag, VisionVerdict } from '../background/diag';
import type { PrewarmDiag, PrewarmVerdict } from '../background/prewarm';
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

const VISION: Record<VisionVerdict, string> = {
  shot: 'picture taken, waiting for the tab to hide',
  reading: 'picture sent to the smart model',
  transcribed: 'transcript stored, picture deleted',
  dropped: 'picture deleted, a chip showed on this page',
  disabled: 'skipped, carat is off',
  'screenshots-off': 'skipped, screenshots are off',
  'site-off': 'skipped, carat is off for this site',
  denylisted: 'skipped, host is on the denylist',
  pinned: 'skipped, context is pinned',
  'not-http': 'skipped, not an http page',
  'not-in-front': 'skipped, the tab was not in front',
  'capture-failed': 'skipped, Chrome refused the picture',
  'no-shot': 'nothing to read, no picture of this tab',
  'no-model': 'nothing read, no smart model configured',
  short: 'nothing kept, the model read too little text',
  failed: 'nothing kept, the smart model failed',
};

/** One line: "page from discord.com 12s ago: stored". */
export function describeCapture(d: CaptureDiag, now: number = Date.now()): string {
  return `${d.kind} from ${d.host} ${relativeAge(d.at, now)}: ${CAPTURE[d.verdict]}`;
}

const ORIGIN: Record<Exclude<AnswerOrigin, 'cache' | 'prewarm'>, string> = {
  entities: 'entities predicted at capture',
  local: 'regex pass',
  jev: 'jev',
  chat: 'chat model',
};

/** One line: "checked 5s ago: regex pass answered first in 4 ms; openai answered in 812 ms with 1, offered 1, 2 candidates under the eager floor (0.35)". */
export function describeSuggest(d: SuggestDiag, now: number = Date.now()): string {
  const when = `checked ${relativeAge(d.at, now)}`;
  if (d.gate !== 'ok') return `${when}: no request, ${GATE[d.gate]}`;
  const first = d.cached
    ? 'answer from cache'
    : d.prewarmed
      ? 'answer was pre-warmed on navigation'
      : d.source && d.source !== 'cache' && d.source !== 'prewarm'
        ? `${ORIGIN[d.source]} answered first in ${d.ms ?? 0} ms`
        : '';
  const attempts = d.cached ? '' : (d.attempts ?? []).map(describeAttempt).join('; ');
  const outcome = [first, attempts].filter(Boolean).join('; ') || 'no provider ran';
  const tabs = d.navigation ? `, ${d.navigation} tab ${d.navigation === 1 ? 'offer' : 'offers'}` : '';
  const controls = d.interactions ? `, ${d.interactions} ${d.interactions === 1 ? 'control' : 'controls'}` : '';
  const level = d.eagerness ?? DEFAULT_EAGERNESS;
  const floor = d.underFloor
    ? `, ${d.underFloor} ${d.underFloor === 1 ? 'candidate' : 'candidates'} under the ${level} floor (${EAGERNESS[level].minConfidence})`
    : '';
  const later = d.refined ? `; ${d.refined} later ${d.refined === 1 ? 'answer' : 'answers'} handed over` : '';
  const smart = d.smart ? '; smart model asked for a second opinion' : d.refine && !d.refined ? '; more may follow' : '';
  return `${when}: ${outcome}, offered ${d.offered ?? 0}${tabs}${controls}${floor}${later}${smart}`;
}

const PREWARM: Record<Exclude<PrewarmVerdict, 'warmed' | 'failed'>, string> = {
  ...GATE,
  warm: 'an answer was already cached or on its way',
  'unknown-page': 'not a page carat knows the fields of',
};

/** One line: "navigation to www.google.com 3s ago: pre-warmed 1 fill (openai, 640 ms)". */
export function describePrewarm(d: PrewarmDiag, now: number = Date.now()): string {
  const when = `navigation to ${d.host} ${relativeAge(d.at, now)}`;
  const call = d.attempts?.[0];
  if (d.verdict === 'warmed') {
    const n = d.count ?? 0;
    return `${when}: pre-warmed ${n} ${n === 1 ? 'fill' : 'fills'}${call ? ` (${call.id}, ${call.ms} ms)` : ''}`;
  }
  if (d.verdict === 'failed') return `${when}: provider failed${call?.error ? ` (${call.error})` : ''}, nothing cached`;
  return `${when}: nothing pre-warmed, ${PREWARM[d.verdict]}`;
}

function describeAttempt(a: ProviderAttempt): string {
  if (a.error) return `${a.id} failed after ${a.ms} ms (${a.error})`;
  return `${a.id} answered in ${a.ms} ms with ${a.count}`;
}

/** One line: `pressed "Pay $312" on aircanada.com 12s ago (Enter)` or `filled f2 on aircanada.com 12s ago, pick left undone`. */
export function describePerform(d: PerformDiag, now: number = Date.now()): string {
  if (d.kind === 'money') return `pressed "${d.name}" on ${d.host} ${relativeAge(d.at, now)} (Enter)`;
  return `filled ${d.name} on ${d.host} ${relativeAge(d.at, now)}, pick left undone`;
}

/** One line: "screenshot of discord.com 12s ago: transcript stored, picture deleted". */
export function describeVision(d: VisionDiag, now: number = Date.now()): string {
  return `screenshot of ${d.host || 'this tab'} ${relativeAge(d.at, now)}: ${VISION[d.verdict]}`;
}
