// Usage: tsx eval/run.ts [--provider local|openai|baseten] [--model <id>] [--base-url <url>] [--eagerness conservative|balanced|eager]
// Runs every fixture in eval/fixtures against one provider at one eagerness level and exits 1 on any
// failure. With --provider local (the default) each fixture is judged against its `expectLocal`: what
// the offline regex placeholder must answer with no network at all. Any other provider is judged
// against `expect`: the action itself.
//   openai, baseten:  OPENAI_API_KEY
import { parseArgs } from 'node:util';
import { DEFAULT_SETTINGS, EAGERNESS, LIMITS, isEagerness, type Settings } from '@carat/shared';
import { createProvider } from '../src/provider';
import { NONE_EXPECTED, judge, loadFixtures, type Verdict } from './fixtures';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'local' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    eagerness: { type: 'string', default: DEFAULT_SETTINGS.eagerness },
  },
});

const provider = values.provider;
if (provider !== 'local' && provider !== 'openai' && provider !== 'baseten') {
  console.error(`unknown provider "${provider}"; use local, openai or baseten`);
  process.exit(2);
}

const eagerness = values.eagerness;
if (!isEagerness(eagerness)) {
  console.error(`unknown eagerness "${eagerness}"; use conservative, balanced or eager`);
  process.exit(2);
}

const apiKey = process.env.OPENAI_API_KEY ?? '';
if ((provider === 'openai' || provider === 'baseten') && apiKey === '') {
  console.error(`--provider ${provider} needs OPENAI_API_KEY in the environment`);
  process.exit(2);
}

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  provider,
  apiKey,
  model: values.model ?? DEFAULT_SETTINGS.model,
  baseURL: values['base-url'] ?? DEFAULT_SETTINGS.baseURL,
  eagerness,
};

const p = createProvider(settings);
const fixtures = await loadFixtures();
const nameWidth = Math.max(...fixtures.map((f) => f.name.length));
const label =
  p.id === 'local'
    ? 'provider=local (judging the offline placeholder)'
    : `provider=${p.id} model=${settings.model}`;
console.log(`${label} eagerness=${eagerness} (floor ${EAGERNESS[eagerness].minConfidence}) fixtures=${fixtures.length}\n`);

let failures = 0;
for (const fixture of fixtures) {
  const request = { ...fixture.request, eagerness };
  const started = performance.now();
  const got = await p
    .next(request, { signal: AbortSignal.timeout(LIMITS.providerTimeoutMs) })
    .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  const ms = Math.round(performance.now() - started);
  const expectation = p.id === 'local' ? (fixture.expectLocal ?? NONE_EXPECTED) : fixture.expect;
  const verdict: Verdict = got instanceof Error ? { pass: false, detail: `provider failed: ${got.message}` } : judge(got, expectation);
  if (!verdict.pass) failures++;
  console.log(`${verdict.pass ? 'PASS' : 'FAIL'}  ${fixture.name.padEnd(nameWidth)}  ${String(ms).padStart(5)}ms  ${verdict.detail}`);
}

console.log(`\n${fixtures.length - failures}/${fixtures.length} passed at ${eagerness}`);
process.exit(failures === 0 ? 0 : 1);
