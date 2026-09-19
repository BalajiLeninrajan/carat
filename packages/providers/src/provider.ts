import type { Settings, SuggestRequest, Suggestion } from '@carat/shared';
import { LocalProvider } from './local';
import { OpenAICompatProvider } from './openai-compat';

export interface Provider {
  readonly id: 'openai' | 'baseten' | 'local';
  suggest(req: SuggestRequest, opts: { signal: AbortSignal }): Promise<Suggestion[]>;
}

export function createProvider(settings: Settings, fetchImpl: typeof fetch = fetch): Provider {
  if (settings.provider === 'local' || !settings.apiKey) return new LocalProvider();
  const baseten = settings.provider === 'baseten';
  return new OpenAICompatProvider(
    {
      id: settings.provider,
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      mode: baseten ? 'json_object' : 'json_schema',
    },
    fetchImpl,
  );
}
