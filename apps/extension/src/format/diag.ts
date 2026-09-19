import type { AnswerOrigin, CaptureDiag, CaptureVerdict, GateVerdict, PerformDiag, ProviderAttempt, SuggestDiag, VisionDiag, VisionVerdict } from '../background/diag';
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
  'no-snapshot': 'nothing on the page to act on',
  password: 'the page has a password field',
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

const ORIGIN: Record<AnswerOrigin, string> = {
  cache: 'answer from the 60s cache',
  placeholder: 'the offline placeholder answered first',
  model: 'the model answered',
  fallback: 'nobody answered, so the page’s plainest step stood in',
};

/**
 * One line: "checked 5s ago: the offline placeholder answered first in 4 ms,
 * fill \"Fill Search with ...\" (0.5); openai answered in 812 ms with click,
 * the model replaced it".
 */
export function describeSuggest(d: SuggestDiag, now: number = Date.now()): string {
  const when = `checked ${relativeAge(d.at, now)}`;
  if (d.gate !== 'ok') return `${when}: no request, ${d.silent ?? GATE[d.gate]}`;
  const first = d.source ? `${ORIGIN[d.source]} in ${d.ms ?? 0} ms` : 'nothing answered';
  const attempts = (d.attempts ?? []).map(describeAttempt).join('; ');
  const action = d.kind
    ? `, ${d.kind}${d.label ? ` "${d.label}"` : ''}${d.confidence !== undefined ? ` (${d.confidence})` : ''}`
    : ', no chip';
  const why = d.reason ? `, ${d.reason}` : '';
  const arm = d.irreversible ? ', asks for a second Tab' : '';
  const refused = d.refused ? `, refused: ${d.refused}` : '';
  const reasked = d.reasked ? `, asked again after "${d.reasked}"` : '';
  const replaced = d.replaced ? ', the model replaced it' : d.refine ? ', more may follow' : '';
  const silent = d.silent ? `, no chip: ${d.silent}` : '';
  return [when, ': ', [first, attempts].filter(Boolean).join('; '), action, why, arm, refused, reasked, replaced, silent, timings(d)].join('');
}

/**
 * The three moments that decide how fast carat feels — the chip going up, the
 * ring landing on the control, the words settling — and whether the prompt's
 * prefix was already in the provider's cache when the request went out.
 */
function timings(d: SuggestDiag): string {
  const parts = [
    d.placeholderMs !== undefined ? `placeholder ${d.placeholderMs} ms` : '',
    d.partialMs !== undefined ? `target ${d.partialMs} ms` : '',
    d.finalMs !== undefined ? `action ${d.finalMs} ms` : '',
    d.warmed === undefined ? '' : d.warmed ? 'prefix warmed' : 'prefix cold',
  ].filter(Boolean);
  return parts.length ? ` [${parts.join(', ')}]` : '';
}

function describeAttempt(a: ProviderAttempt): string {
  if (a.error) return `${a.id} failed after ${a.ms} ms (${a.error})`;
  return `${a.id} answered in ${a.ms} ms with ${a.kind}`;
}

/** One line: `pressed "Pay $312" on aircanada.com 12s ago (armed, second Tab)` or `filled f2 on aircanada.com 12s ago, pick left undone`. */
export function describePerform(d: PerformDiag, now: number = Date.now()): string {
  if (d.kind === 'armed') return `pressed "${d.name}" on ${d.host} ${relativeAge(d.at, now)} (armed, second Tab)`;
  return `filled ${d.name} on ${d.host} ${relativeAge(d.at, now)}, pick left undone`;
}

/** One line: "screenshot of discord.com 12s ago: transcript stored, picture deleted". */
export function describeVision(d: VisionDiag, now: number = Date.now()): string {
  return `screenshot of ${d.host || 'this tab'} ${relativeAge(d.at, now)}: ${VISION[d.verdict]}`;
}
