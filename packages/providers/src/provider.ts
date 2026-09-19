import type { Settings, SuggestRequest, Suggestion } from '@carat/shared';
import { FastThenSmartProvider } from './fast-then-smart';
import { JevProvider } from './jev';
import { LocalProvider } from './local';
import { OpenAICompatProvider } from './openai-compat';

export interface Provider {
  readonly id: Settings['provider'];
  suggest(req: SuggestRequest, opts: { signal: AbortSignal }): Promise<Suggestion[]>;
}

/**
 * local: regex only. openai/baseten: the chat model when a key is set, else
 * regex. cloudflare: Jev first when an account id and token are set, then the
 * chat model at baseURL when a key is set too; without Cloudflare credentials
 * it behaves like openai.
 */
export function createProvider(settings: Settings, fetchImpl: typeof fetch = fetch): Provider {
  if (settings.provider === 'local') return new LocalProvider();

  const chat: 'openai' | 'baseten' =
    settings.provider === 'cloudflare' ? (isOpenAI(settings.baseURL) ? 'openai' : 'baseten') : settings.provider;
  const llm = settings.apiKey
    ? new OpenAICompatProvider(
        {
          id: chat,
          baseURL: settings.baseURL,
          apiKey: settings.apiKey,
          model: settings.model,
          mode: chat === 'openai' ? 'json_schema' : 'json_object',
        },
        fetchImpl,
      )
    : null;

  if (settings.provider === 'cloudflare' && settings.cfAccountId && settings.cfApiToken) {
    const jev = new JevProvider({ accountId: settings.cfAccountId, apiToken: settings.cfApiToken }, fetchImpl);
    return llm ? new FastThenSmartProvider(jev, llm) : jev;
  }
  return llm ?? new LocalProvider();
}

// Only OpenAI's own endpoint is known to honour strict json_schema; other
// OpenAI-compatible servers get json_object, as the baseten setting does.
function isOpenAI(baseURL: string): boolean {
  try {
    return new URL(baseURL).host === 'api.openai.com';
  } catch {
    return false;
  }
}
