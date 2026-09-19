// Usage: tsx eval/run.ts [--provider local|openai|baseten] [--model <id>] [--base-url <url>]
// Runs every fixture in eval/fixtures against one provider and exits 1 on any failure.
import { parseArgs } from 'node:util';
import { DEFAULT_SETTINGS, LIMITS, type Settings } from '@carat/shared';
import { createProvider } from '../src/provider';
import { judge, loadFixtures } from './fixtures';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'local' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
  },
});

const provider = values.provider;
if (provider !== 'local' && provider !== 'openai' && provider !== 'baseten') {
  console.error(`unknown provider "${provider}"; use local, openai or baseten`);
  process.exit(2);
}

const apiKey = process.env.OPENAI_API_KEY ?? '';
if (provider !== 'local' && apiKey === '') {
  console.error(`--provider ${provider} needs OPENAI_API_KEY in the environment`);
  process.exit(2);
}

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  provider,
  apiKey,
  model: values.model ?? DEFAULT_SETTINGS.model,
  baseURL: values['base-url'] ?? DEFAULT_SETTINGS.baseURL,
};

const p = createProvider(settings);
const fixtures = await loadFixtures();
const nameWidth = Math.max(...fixtures.map((f) => f.name.length));
console.log(`provider=${p.id}${p.id === 'local' ? '' : ` model=${settings.model}`} fixtures=${fixtures.length}\n`);

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
