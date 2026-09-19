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

export interface SuggestRequest {
  page: PageMeta;
  fields: FieldDescriptor[];
  context: Array<Pick<ContextItem, 'id' | 'origin' | 'title' | 'kind' | 'text' | 'capturedAt'>>;
  now: string; // ISO
  locale?: string;
}

export interface Suggestion {
  fieldId: string;
  value: string;
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
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-5.6-luna',
};

export const LIMITS = {
  titleChars: 80,
  pageTextChars: 4000,
  selectionTextChars: 1000,
  minConfidence: 0.7,
  maxSuggestions: 2,
  providerTimeoutMs: 6000,
} as const;
