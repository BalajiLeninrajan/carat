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

/** Roles carat can act on. Derived from the tag, the input type or an explicit ARIA role; nothing else is described. */
export type ElementRole =
  | 'button'
  | 'link'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'slider'
  | 'select'
  | 'tab'
  | 'menuitem'
  | 'disclosure';

/**
 * One interactive element, as the model sees it. No coordinates, no DOM: a
 * role, an accessible name, the current state or value, the range for
 * sliders, the options for selects, and nearby text.
 */
export interface ElementDescriptor {
  i: string; // 'e0'..'e15'
  r: ElementRole;
  nm: string; // accessible name, <= 60, never empty
  st?: 'on' | 'off' | 'open' | 'closed' | 'selected'; // checkbox/switch/radio/disclosure/tab state
  v?: string; // current value, <= 40 (slider, select)
  min?: number; // sliders
  max?: number;
  step?: number;
  op?: string[]; // select options, <= 8 x 20 chars
  nb?: string; // nearby text, <= 80
  p?: 1; // the page's primary action (submit button, or styled as primary)
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
  /** Interactive elements on the page. Omitted when empty. */
  elements?: ElementDescriptor[];
  /** Context ids behind fills carat performed on this tab in the last minute. A click on a Save-like button cites one of them. Omitted when empty. */
  filled?: string[];
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

export type InteractVerb = 'click' | 'check' | 'uncheck' | 'set' | 'choose';

/**
 * One interaction with one element on the current page. `value` is the target
 * for `set` (a number as text) and `choose` (an option label); for `click`,
 * `check` and `uncheck` it repeats the element's name. The content script
 * performs it, once, after a Tab on the chip.
 */
export interface InteractSuggestion {
  kind: 'interact';
  elementId: string;
  verb: InteractVerb;
  value: string;
  confidence: number;
  reason: string;
  sourceContextId: string;
}

/** What a provider returns. */
export type Suggestion = FillSuggestion | ActionSuggestion | InteractSuggestion;

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
  provider: 'openai' | 'baseten' | 'local' | 'cloudflare';
  baseURL: string; // default https://api.openai.com/v1
  apiKey: string; // may be ''
  model: string; // default gpt-5.6-luna
  cfAccountId: string; // Cloudflare account id for Workers AI; may be ''
  cfApiToken: string; // Workers AI token; stays in chrome.storage.local like apiKey
  disabledHosts: string[]; // exact hosts (with port) where carat neither reads nor suggests
  statusLine: boolean; // small bottom-right line on every page: running or not, and which model
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
