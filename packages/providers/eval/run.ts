// Usage: tsx eval/run.ts [--provider local|openai|baseten|cloudflare] [--model <id>] [--base-url <url>] [--eagerness conservative|balanced|eager]
// Runs every fixture in eval/fixtures against one provider at one eagerness level (default: the
// product default) and exits 1 on any failure. A negative that produced only chips weak enough for
// the level to tolerate prints as WEAK and counts as a pass.
//   openai, baseten:  OPENAI_API_KEY
//   cloudflare:       CF_ACCOUNT_ID and CF_API_TOKEN; with OPENAI_API_KEY also set, the
//                     chat model races Jev and the surer answer wins each field.
import { parseArgs } from 'node:util';
import { DEFAULT_SETTINGS, EAGERNESS, LIMITS, isEagerness, type Settings } from '@carat/shared';
import { createProvider } from '../src/provider';
import { JEV_MODEL } from '../src/jev';
import { judge, loadFixtures, type Verdict } from './fixtures';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'local' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    eagerness: { type: 'string', default: DEFAULT_SETTINGS.eagerness },
  },
});

const provider = values.provider;
if (provider !== 'local' && provider !== 'openai' && provider !== 'baseten' && provider !== 'cloudflare') {
  console.error(`unknown provider "${provider}"; use local, openai, baseten or cloudflare`);
  process.exit(2);
}

const eagerness = values.eagerness;
if (!isEagerness(eagerness)) {
  console.error(`unknown eagerness "${eagerness}"; use conservative, balanced or eager`);
  process.exit(2);
}

const apiKey = process.env.OPENAI_API_KEY ?? '';
const cfAccountId = process.env.CF_ACCOUNT_ID ?? '';
const cfApiToken = process.env.CF_API_TOKEN ?? '';
if ((provider === 'openai' || provider === 'baseten') && apiKey === '') {
  console.error(`--provider ${provider} needs OPENAI_API_KEY in the environment`);
  process.exit(2);
}
if (provider === 'cloudflare' && (cfAccountId === '' || cfApiToken === '')) {
  const missing = [cfAccountId === '' && 'CF_ACCOUNT_ID', cfApiToken === '' && 'CF_API_TOKEN'].filter(Boolean).join(' and ');
  console.error(
    `--provider cloudflare needs ${missing} in the environment.\n` +
      'CF_ACCOUNT_ID is the Workers AI account id; CF_API_TOKEN is an API token with the Workers AI permission.\n' +
      'Set OPENAI_API_KEY as well to race the chat model against Jev.',
  );
  process.exit(2);
}

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  provider,
  apiKey,
  cfAccountId,
  cfApiToken,
  model: values.model ?? DEFAULT_SETTINGS.model,
  baseURL: values['base-url'] ?? DEFAULT_SETTINGS.baseURL,
  eagerness,
};

const p = createProvider(settings);
const fixtures = await loadFixtures();
const nameWidth = Math.max(...fixtures.map((f) => f.name.length));
const label =
  p.id === 'local'
    ? 'provider=local'
    : p.id === 'cloudflare'
      ? `provider=cloudflare model=${JEV_MODEL}${apiKey ? ` and ${settings.model}` : ' (no OPENAI_API_KEY: Jev alone)'}`
      : `provider=${p.id} model=${settings.model}`;
console.log(`${label} eagerness=${eagerness} (floor ${EAGERNESS[eagerness].minConfidence}) fixtures=${fixtures.length}\n`);

let failures = 0;
let weak = 0;
for (const fixture of fixtures) {
  const started = performance.now();
  const got = await p
    .suggest(fixture.request, { signal: AbortSignal.timeout(LIMITS.providerTimeoutMs) })
    .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  const ms = Math.round(performance.now() - started);
  const verdict: Verdict = got instanceof Error ? { pass: false, detail: `provider failed: ${got.message}` } : judge(fixture, got, eagerness);
  if (!verdict.pass) failures++;
  if (verdict.weak) weak++;
  const mark = verdict.weak ? 'WEAK' : verdict.pass ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${fixture.name.padEnd(nameWidth)}  ${String(ms).padStart(5)}ms  ${verdict.detail}`);
}

const weakNote = weak > 0 ? ` (${weak} weak ${weak === 1 ? 'chip' : 'chips'} tolerated at ${eagerness})` : '';
console.log(`\n${fixtures.length - failures}/${fixtures.length} passed at ${eagerness}${weakNote}`);
process.exit(failures === 0 ? 0 : 1);
