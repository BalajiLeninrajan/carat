import type { GhostRequest, ImageInput, NextAction, NextActionRequest, Settings } from '@carat/shared';
import { JevProvider } from './jev';
import { LocalProvider } from './local';
import { OpenAICompatProvider } from './openai-compat';
import type { ReasoningEffort, RelaxStore } from './openai-compat';
import { RaceProvider } from './race';

export interface NextOptions {
  signal: AbortSignal;
  /**
   * The target as soon as the streamed JSON carries it, before the label and
   * the rest have arrived, so the content script can ring the control while
   * the model is still writing. Called at most once per call.
   */
  onPartial?: (partial: { target: number | null }) => void;
  /**
   * The reply exactly as it arrived, before it is parsed or salvaged. Set
   * only while a tab's debug panel is open; providers with no text to hand
   * back (the regex placeholder, Jev's choice call) leave it alone.
   */
  onRaw?: (text: string) => void;
}

/** The ghost's question: the text so far, plus the page it is being typed on. */
export interface CompleteRequest extends GhostRequest {
  /** 24 for a one-line field, 48 for a textarea or an editor. */
  maxTokens: number;
  /** For the prompt cache key, which is one entry per origin and path. */
  page?: { host: string; path: string };
}

export interface CompleteOptions {
  signal: AbortSignal;
  /** The cleaned text so far, after every chunk, so the first token is drawn before the last arrives. */
  onDelta?: (soFar: string) => void;
}

/** One page in, one action out. Swapping providers only ever means implementing this. */
export interface Provider {
  readonly id: Settings['provider'];
  /** The action, or null when this provider has nothing (a failure resolves as a rejection). */
  next(req: NextActionRequest, opts: NextOptions): Promise<NextAction | null>;
  /**
   * Put the request's cached prefix in front of the model before the page has
   * been read, so the real call only pays for the outline. Fire and forget:
   * the answer is thrown away and a failure is never raised. Providers with
   * no network behind them leave it out.
   */
  warm?(req: NextActionRequest, opts: { signal: AbortSignal }): Promise<void>;
  /**
   * The grey text after the caret: a short continuation of what the user is
   * typing, as plain text. Empty means "nothing to add", which is how Tab
   * goes back to the next-action path. Providers with no network behind them
   * leave it out.
   */
  complete?(req: CompleteRequest, opts: CompleteOptions): Promise<string>;
}

/** The model that also reads screenshots and distills a page the user left into notes. */
export interface VisionProvider extends Provider {
  transcribe(image: ImageInput, opts: { signal: AbortSignal }): Promise<string>;
  distill(text: string, host: string, signal: AbortSignal): Promise<string[]>;
}

/**
 * local: the regex placeholder alone, no network. Anything else races the
 * placeholder against the model so a chip is up in the first tick and the
 * model replaces it behind a ticket: openai/baseten add the chat model when a
 * key is set; cloudflare adds Jev when an account id and token are set, and
 * the chat model at baseURL when a key is set too. Start order is also rank
 * on a tie: chat beats Jev beats regex.
 */
export function createProvider(settings: Settings, fetchImpl: typeof fetch = fetch, relax?: RelaxStore): Provider {
  if (settings.provider === 'local') return new LocalProvider();
  const sources: Provider[] = [new LocalProvider()];
  const jev = settings.provider === 'cloudflare' && settings.cfAccountId && settings.cfApiToken;
  if (jev) sources.push(new JevProvider({ accountId: settings.cfAccountId, apiToken: settings.cfApiToken }, fetchImpl));
  const llm = chatProvider(settings, settings.model, 'none', fetchImpl, relax);
  if (llm) sources.push(llm);
  if (sources.length === 1) return sources[0]!;
  return new RaceProvider(sources, { id: jev ? 'cloudflare' : llm!.id });
}

/**
 * The model that reads screenshots and writes notes: the same one by default,
 * with low reasoning instead of none; `smartModel` swaps in a bigger one.
 * Undefined when there is no chat model at all, since neither the regex
 * placeholder nor Jev can read an image or write a sentence.
 */
export function createVisionProvider(settings: Settings, fetchImpl: typeof fetch = fetch, relax?: RelaxStore): VisionProvider | undefined {
  if (settings.provider === 'local') return undefined;
  return chatProvider(settings, settings.smartModel || settings.model, 'low', fetchImpl, relax) ?? undefined;
}

/**
 * The model behind the ghost: the fast one the engine already uses, with no
 * reasoning. Undefined when there is no chat model, since neither the regex
 * placeholder nor Jev can write a sentence.
 */
export function createCompleter(settings: Settings, fetchImpl: typeof fetch = fetch, relax?: RelaxStore): OpenAICompatProvider | undefined {
  if (settings.provider === 'local') return undefined;
  return chatProvider(settings, settings.model, 'none', fetchImpl, relax) ?? undefined;
}

function chatProvider(
  settings: Settings,
  model: string,
  effort: ReasoningEffort,
  fetchImpl: typeof fetch,
  relax: RelaxStore | undefined,
): OpenAICompatProvider | null {
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
      ...(relax ? { relaxStore: relax } : {}),
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
