import type { ImageInput, Settings, SuggestRequest, Suggestion } from '@carat/shared';
import { FastThenSmartProvider } from './fast-then-smart';
import { JevProvider } from './jev';
import { LocalProvider } from './local';
import { OpenAICompatProvider } from './openai-compat';
import type { ReasoningEffort } from './openai-compat';

/** The fast path: text in, suggestions out. Swapping providers only ever means implementing this. */
export interface Provider {
  readonly id: Settings['provider'];
  suggest(req: SuggestRequest, opts: { signal: AbortSignal }): Promise<Suggestion[]>;
}

/** The smart path: the same text-only suggest on a bigger model, plus reading a screenshot into text. */
export interface VisionProvider extends Provider {
  transcribe(image: ImageInput, opts: { signal: AbortSignal }): Promise<string>;
}

/**
 * local: regex only. openai/baseten: the chat model when a key is set, else
 * regex. cloudflare: Jev first when an account id and token are set, then the
 * chat model at baseURL when a key is set too; without Cloudflare credentials
 * it behaves like openai. The chat model runs with no reasoning: the chip
 * has a 6s budget and the prompt carries the few-shots it needs.
 */
export function createProvider(settings: Settings, fetchImpl: typeof fetch = fetch): Provider {
  if (settings.provider === 'local') return new LocalProvider();
  const llm = chatProvider(settings, settings.model, 'none', fetchImpl);

  if (settings.provider === 'cloudflare' && settings.cfAccountId && settings.cfApiToken) {
    const jev = new JevProvider({ accountId: settings.cfAccountId, apiToken: settings.cfApiToken }, fetchImpl);
    return llm ? new FastThenSmartProvider(jev, llm) : jev;
  }
  return llm ?? new LocalProvider();
}

/**
 * The same chat model as the fast path by default, with low reasoning
 * instead of none; `smartModel` swaps in a bigger one for those who want it.
 * Same endpoint either way. Undefined when there is no chat model to be
 * smart with: the regex fallback cannot read images, and Jev can neither read
 * an image nor write a value, so a cloudflare setup without a key has no
 * smart path.
 */
export function createSmartProvider(settings: Settings, fetchImpl: typeof fetch = fetch): VisionProvider | undefined {
  if (settings.provider === 'local') return undefined;
  return chatProvider(settings, settings.smartModel || settings.model, 'low', fetchImpl) ?? undefined;
}

function chatProvider(settings: Settings, model: string, effort: ReasoningEffort, fetchImpl: typeof fetch): OpenAICompatProvider | null {
  if (settings.provider === 'local' || !settings.apiKey) return null;
  const chat: 'openai' | 'baseten' =
    settings.provider === 'cloudflare' ? (isOpenAI(settings.baseURL) ? 'openai' : 'baseten') : settings.provider;
  return new OpenAICompatProvider(
    {
      id: chat,
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model,
      mode: chat === 'openai' ? 'json_schema' : 'json_object',
      // Only OpenAI's own endpoint is known to take reasoning_effort; a vLLM or Baseten server may 400 on it.
      ...(isOpenAI(settings.baseURL) ? { reasoningEffort: effort } : {}),
    },
    fetchImpl,
  );
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
