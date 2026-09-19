export interface ContextItem {
  id: string;
  tabId: number;
  origin: string;
  path: string; // no query, no hash
  title: string; // <= 80 chars
  kind: 'page' | 'selection';
  text: string; // page <= 4000 chars, selection <= 1000
  hash: number; // FNV-1a of normalized text
  capturedAt: number;
  lastSeenAt: number;
}

export interface FieldDescriptor {
  i: string; // 'f0'..'f11'
  t: string; // 'input:text' | 'input:search' | 'textarea' | 'ce' | 'combobox' | ...
  nm?: string; // name or id, <= 40
  ph?: string; // placeholder, <= 60
  al?: string; // aria-label, <= 60
  lb?: string; // label text, <= 60
  nb?: string; // nearby text, <= 80
  ac?: string; // autocomplete attr
  v?: string; // current value, <= 40
  f?: 1; // focused
  w?: 's' | 'm' | 'l'; // width bucket
}

export interface PageMeta {
  host: string;
  title: string;
  path: string;
  h1?: string;
}

export type RequestContext = Array<Pick<ContextItem, 'id' | 'origin' | 'title' | 'kind' | 'text' | 'capturedAt'>>;

export interface SuggestRequest {
  page: PageMeta;
  fields: FieldDescriptor[];
  /** Text from other tabs: the only source for field fills. */
  context: RequestContext;
  /** Text captured from the requesting tab itself: a source for actions, never for fills. Omitted when empty. */
  own?: RequestContext;
  now: string; // ISO
  locale?: string;
}

/** Destinations carat knows how to build a URL for. The model names one; it never writes the URL. */
export const INTENTS = ['maps', 'calendar', 'gmail'] as const;
export type IntentName = (typeof INTENTS)[number];

export function isIntentName(v: unknown): v is IntentName {
  return typeof v === 'string' && (INTENTS as readonly string[]).includes(v);
}

/** A value for one field on the current page. */
export interface FillSuggestion {
  kind: 'fill';
  fieldId: string;
  value: string;
  confidence: number;
  reason: string;
  sourceContextId: string;
}

/**
 * Something the user may want to do next on another site, extracted from what
 * they are reading. `value` is the entity (place, event title, email address);
 * `when` is an ISO 8601 start with offset or ''; `location` is an address or
 * place name for calendar, else ''.
 */
export interface ActionSuggestion {
  kind: 'action';
  intent: IntentName;
  value: string;
  when: string;
  location: string;
  confidence: number;
  reason: string;
  sourceContextId: string;
}

/** What a provider returns. */
export type Suggestion = FillSuggestion | ActionSuggestion;

/**
 * An action resolved against the registry and the user's open tabs. `open`
 * creates a tab at `url`; `focus` navigates the existing tab `tabId` there and
 * brings it forward. Nothing happens until the user presses Tab on the chip.
 */
export interface NavSuggestion {
  kind: 'open' | 'focus';
  intent: IntentName;
  label: string; // "Open in Google Maps"
  value: string;
  when: string;
  location: string;
  url: string;
  tabId?: number;
  confidence: number;
  reason: string;
  sourceContextId: string;
}

export interface Settings {
  enabled: boolean;
  provider: 'openai' | 'baseten' | 'local';
  baseURL: string; // default https://api.openai.com/v1
  apiKey: string; // may be ''
  model: string; // default gpt-5.6-luna
  disabledHosts: string[]; // exact hosts (with port) where carat neither reads nor suggests
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-5.6-luna',
  disabledHosts: [],
};

export const LIMITS = {
  titleChars: 80,
  pageTextChars: 4000,
  selectionTextChars: 1000,
  minConfidence: 0.7,
  maxSuggestions: 2,
  maxNavigations: 2,
  providerTimeoutMs: 6000,
} as const;
