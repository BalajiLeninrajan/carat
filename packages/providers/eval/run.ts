// Usage: tsx eval/run.ts [--provider local|openai|baseten|cloudflare] [--model <id>] [--base-url <url>]
// Runs every fixture in eval/fixtures against one provider and exits 1 on any failure.
//   openai, baseten:  OPENAI_API_KEY
//   cloudflare:       CF_ACCOUNT_ID and CF_API_TOKEN; with OPENAI_API_KEY also set, the
//                     chat model runs after Jev on the fixtures Jev leaves empty.
import { parseArgs } from 'node:util';
import { DEFAULT_SETTINGS, LIMITS, type Settings } from '@carat/shared';
import { createProvider } from '../src/provider';
import { JEV_MODEL } from '../src/jev';
import { judge, loadFixtures } from './fixtures';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'local' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
  },
});

const provider = values.provider;
if (provider !== 'local' && provider !== 'openai' && provider !== 'baseten' && provider !== 'cloudflare') {
  console.error(`unknown provider "${provider}"; use local, openai, baseten or cloudflare`);
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
      'Set OPENAI_API_KEY as well to run the chat model after Jev on the fixtures Jev leaves empty.',
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
};

const p = createProvider(settings);
const fixtures = await loadFixtures();
const nameWidth = Math.max(...fixtures.map((f) => f.name.length));
const label =
  p.id === 'local'
    ? 'provider=local'
    : p.id === 'cloudflare'
      ? `provider=cloudflare model=${JEV_MODEL}${apiKey ? ` then ${settings.model}` : ' (no OPENAI_API_KEY: Jev alone)'}`
      : `provider=${p.id} model=${settings.model}`;
console.log(`${label} fixtures=${fixtures.length}\n`);

let failures = 0;
for (const fixture of fixtures) {
  const started = performance.now();
  const got = await p
    .suggest(fixture.request, { signal: AbortSignal.timeout(LIMITS.providerTimeoutMs) })
    .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  const ms = Math.round(performance.now() - started);
  const verdict = got instanceof Error ? { pass: false, detail: `provider failed: ${got.message}` } : judge(fixture, got);
  if (!verdict.pass) failures++;
  console.log(
    `${verdict.pass ? 'PASS' : 'FAIL'}  ${fixture.name.padEnd(nameWidth)}  ${String(ms).padStart(5)}ms  ${verdict.detail}`,
  );
}

console.log(`\n${fixtures.length - failures}/${fixtures.length} passed`);
process.exit(failures === 0 ? 0 : 1);
