import type { Eagerness } from './eagerness';
import { DEFAULT_EAGERNESS } from './eagerness';

/** `vision` is text a model read off a screenshot of the tab; it is distilled into notes like any other page. */
export type ContextKind = 'page' | 'selection' | 'vision';

export interface ContextItem {
  id: string;
  tabId: number;
  origin: string;
  path: string; // no query, no hash
  title: string; // <= 80 chars
  kind: ContextKind;
  text: string; // page and vision <= 4000 chars, selection <= 1000
  hash: number; // FNV-1a of normalized text
  capturedAt: number;
  lastSeenAt: number;
}

export interface PageMeta {
  host: string;
  title: string;
  path: string;
  h1?: string;
}

export interface Settings {
  enabled: boolean;
  provider: 'openai' | 'baseten' | 'local' | 'cloudflare';
  baseURL: string; // default https://api.openai.com/v1
  apiKey: string; // may be ''
  model: string; // default gpt-5.6-luna
  cfAccountId: string; // Cloudflare account id for Workers AI; may be ''
  cfApiToken: string; // Workers AI token; stays in chrome.storage.local like apiKey
  disabledHosts: string[]; // exact hosts (with port) where carat neither reads nor suggests
  statusLine: boolean; // small bottom-right line on every page: running or not, and which model
  /** Opt-in: screenshot thin source tabs and read them into notes. Default off. */
  screenshots: boolean;
  /**
   * Optional override for reading screenshots. Blank means the same model the
   * engine uses, run with low reasoning instead of none. Whatever it is must
   * accept images.
   */
  smartModel: string;
  /**
   * Optional Elasticsearch context layer. When `elasticUrl` and
   * `elasticApiKey` are present, captures, distilled facts and accepted
   * actions are indexed under `elasticIndexPrefix` and retrieved before each
   * model call.
   */
  elasticUrl: string;
  elasticApiKey: string;
  elasticIndexPrefix: string;
  /**
   * Optional Elastic inference endpoint for `semantic_text`. Blank keeps the
   * index lexical-only. Set it to `default` to use Elastic's deployment
   * default, or an endpoint id such as `.elser-2-elasticsearch`/a configured
   * Jina endpoint, to enable RRF hybrid retrieval.
   */
  elasticInferenceId: string;
  /**
   * How readily a chip is offered. `balanced` is the default; `eager`
   * guesses more readily and `conservative` only answers when the model is sure.
   * See EAGERNESS.
   */
  eagerness: Eagerness;
}

/**
 * Why a tab was worth a picture. `thin-text`: little visible body text, so the
 * picture mostly stands in for text and a small rendering reads fine.
 * `image-heavy`: the text was there but an image or canvas filled the view, so
 * the interesting part is inside that image and needs the full rendering.
 */
export type ImageCue = 'thin-text' | 'image-heavy';

/** A downscaled screenshot handed to the vision model, plus where, when and why it was taken. */
export interface ImageInput {
  dataUrl: string; // data:image/jpeg;base64,...
  title: string;
  host: string;
  /** Time of the capture, ISO 8601 with offset; relative dates in the picture are resolved against it. */
  now: string;
  cue: ImageCue;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-5.6-luna',
  cfAccountId: '',
  cfApiToken: '',
  disabledHosts: [],
  statusLine: false,
  screenshots: false,
  smartModel: '',
  elasticUrl: '',
  elasticApiKey: '',
  elasticIndexPrefix: 'carat',
  elasticInferenceId: '',
  eagerness: DEFAULT_EAGERNESS,
};

export const LIMITS = {
  titleChars: 80,
  pageTextChars: 4000,
  selectionTextChars: 1000,
  /** The whole engine budget: the placeholder goes out at once, the model has this long behind it. */
  providerTimeoutMs: 6000,
  /** Body text under this many chars marks a source tab as thin enough to screenshot. */
  thinTextChars: 400,
  transcribeTimeoutMs: 20000,
  /** The notes call on a page the user just left. */
  distillTimeoutMs: 15000,
  /** The outline handed to the model, in characters. */
  outlineChars: 9000,
} as const;
