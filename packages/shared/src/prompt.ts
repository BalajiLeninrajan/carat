import type { SuggestRequest } from './types';
import type { SuggestionList } from './schema';

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// Byte-identical across calls so the provider's prompt cache hits.
export const SYSTEM_PROMPT = [
  'You are Carat, a browser assistant. You propose values for form fields on the current page using text the user recently read in other tabs, and you propose the next site the user may want to open based on what they are reading now.',
  '',
  'Input: JSON with `page` (the current page), `fields` (candidate fields with short descriptors), `context` (recent text from other tabs, newest first), `own` (text from the current tab itself, when present) and `now` (current ISO time with offset).',
  'Output: JSON `{"suggestions": [...]}`. Every suggestion has all of these keys: `kind`, `fieldId`, `value`, `confidence` (0..1), `reason` (one short clause), `sourceContextId`, `intent`, `when`, `location`. Keys that do not apply are "".',
  '',
  'Two kinds:',
  '- `kind: "fill"`: `fieldId` names the field, `value` is exactly what goes in it, `sourceContextId` is an item in `context`. `intent`, `when` and `location` are "".',
  '- `kind: "action"`: `fieldId` is "", `sourceContextId` is an item in `own`, `intent` is one of `maps` (value = place name), `calendar` (value = short event title such as "Dinner at Seven Shores Cafe", `when` = ISO 8601 start with offset, `location` = address or place name) or `gmail` (value = email address). Carat builds the URL itself; never put a URL anywhere.',
  '',
  'Rules:',
  '1. Only propose a fill when a specific value in `context` clearly matches the purpose of the field. A vague topical match is not enough.',
  '2. Prefer proper nouns, places, addresses, names, emails, phone numbers, dates, times and codes. Never propose generic words.',
  '3. `value` is exactly what goes in the field, not a sentence. No quotes, no trailing punctuation, no explanation.',
  '4. Resolve relative dates and times ("Friday at 6", "tomorrow") against `now`, and format them the way the field expects.',
  '5. An address belongs in a location field. An event or place name belongs in a title or search field. Do not swap them.',
  '6. At most one fill per field. Never fill a field that already has a value.',
  '7. Fills never use `own`: text from the page being filled is never proposed back into it.',
  '8. Only propose an action for a concrete plan, invitation or request in `own` that the user would act on next (a place to look up, an event to add, a person to email). News, reviews and past events get no action. Never propose an action whose destination is the current page.',
  '9. When unsure, return an empty list. No suggestion beats a wrong one.',
].join('\n');

const FEW_SHOT_MAPS_REQUEST: SuggestRequest = {
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' },
  fields: [
    {
      i: 'f0',
      t: 'input:text',
      nm: 'searchboxinput',
      ph: 'Search Google Maps',
      al: 'Search Google Maps',
      f: 1,
      w: 'l',
    },
  ],
  context: [
    {
      id: 'c1',
      origin: 'https://discord.com',
      title: 'Discord | #general | Waterloo Friends',
      kind: 'page',
      text: 'Discord discord.com #general alex: dinner at Seven Shores Cafe, Friday at 6? sam: sounds good, see you there priya: in',
      capturedAt: 1758046800000,
    },
  ],
  now: '2026-09-16T14:04:00-04:00',
};

const FEW_SHOT_MAPS_RESPONSE: SuggestionList = {
  suggestions: [
    {
      kind: 'fill',
      fieldId: 'f0',
      value: 'Seven Shores Cafe',
      confidence: 0.92,
      reason: 'Discord message names a meeting place; Maps search takes a place name',
      sourceContextId: 'c1',
    },
  ],
};

const FEW_SHOT_CALENDAR_REQUEST: SuggestRequest = {
  page: {
    host: 'calendar.google.com',
    title: 'Google Calendar - Week of September 14, 2026',
    path: '/calendar/u/0/r/eventedit',
  },
  fields: [
    { i: 'f0', t: 'input:text', al: 'Add title', ph: 'Add title', w: 'l' },
    { i: 'f1', t: 'input:text', al: 'Add location', ph: 'Add location', f: 1, w: 'm' },
    { i: 'f2', t: 'ce', al: 'Description', w: 'l' },
  ],
  context: [
    {
      id: 'c2',
      origin: 'https://www.google.com',
      title: 'Seven Shores Cafe - Google Maps',
      kind: 'page',
      text: 'Seven Shores Cafe - Google Maps www.google.com Seven Shores Cafe 4.6 (312) Cafe 10 Regina St N, Waterloo, ON N2J 2Z8 Open Closes 9 p.m. (519) 555-0142 sevenshores.ca Directions Save Share',
      capturedAt: 1758046920000,
    },
    {
      id: 'c1',
      origin: 'https://discord.com',
      title: 'Discord | #general | Waterloo Friends',
      kind: 'page',
      text: 'Discord discord.com #general alex: dinner at Seven Shores Cafe, Friday at 6? sam: sounds good, see you there priya: in',
      capturedAt: 1758046800000,
    },
  ],
  now: '2026-09-16T14:06:00-04:00',
};

const FEW_SHOT_CALENDAR_RESPONSE: SuggestionList = {
  suggestions: [
    {
      kind: 'fill',
      fieldId: 'f1',
      value: '10 Regina St N, Waterloo, ON N2J 2Z8',
      confidence: 0.9,
      reason: 'Maps panel shows the street address of the place being planned; location field takes an address',
      sourceContextId: 'c2',
    },
    {
      kind: 'fill',
      fieldId: 'f0',
      value: 'Dinner at Seven Shores Cafe',
      confidence: 0.8,
      reason: 'Discord message describes the event; title field takes an event name',
      sourceContextId: 'c1',
    },
  ],
};

// The action case: reading the invitation on Discord itself, with no other tab to draw on.
const FEW_SHOT_ACTION_REQUEST: SuggestRequest = {
  page: { host: 'discord.com', title: 'Discord | #general | Waterloo Friends', path: '/channels/1/2' },
  fields: [{ i: 'f0', t: 'textbox', al: 'Message #general', w: 'l' }],
  context: [],
  own: [
    {
      id: 'o1',
      origin: 'https://discord.com',
      title: 'Discord | #general | Waterloo Friends',
      kind: 'page',
      text: 'Discord discord.com #general alex: dinner at Seven Shores Cafe, Friday at 6? sam: sounds good, see you there priya: in',
      capturedAt: 1758046800000,
    },
  ],
  now: '2026-09-16T14:02:00-04:00',
};

const FEW_SHOT_ACTION_RESPONSE: SuggestionList = {
  suggestions: [
    {
      kind: 'action',
      intent: 'maps',
      value: 'Seven Shores Cafe',
      when: '',
      location: '',
      confidence: 0.9,
      reason: 'invitation names a place the user will need to find',
      sourceContextId: 'o1',
    },
    {
      kind: 'action',
      intent: 'calendar',
      value: 'Dinner at Seven Shores Cafe',
      when: '2026-09-18T18:00:00-04:00',
      location: 'Seven Shores Cafe',
      confidence: 0.8,
      reason: 'invitation has a place and a time; Friday at 6 resolves to the coming Friday evening',
      sourceContextId: 'o1',
    },
  ],
};

const wire = (list: SuggestionList): string =>
  JSON.stringify({
    suggestions: list.suggestions.map((s) =>
      s.kind === 'fill'
        ? { ...s, intent: '', when: '', location: '' }
        : { kind: s.kind, fieldId: '', value: s.value, confidence: s.confidence, reason: s.reason, sourceContextId: s.sourceContextId, intent: s.intent, when: s.when, location: s.location },
    ),
  });

export const FEW_SHOTS: readonly ChatMessage[] = [
  { role: 'user', content: JSON.stringify(FEW_SHOT_MAPS_REQUEST) },
  { role: 'assistant', content: wire(FEW_SHOT_MAPS_RESPONSE) },
  { role: 'user', content: JSON.stringify(FEW_SHOT_CALENDAR_REQUEST) },
  { role: 'assistant', content: wire(FEW_SHOT_CALENDAR_RESPONSE) },
  { role: 'user', content: JSON.stringify(FEW_SHOT_ACTION_REQUEST) },
  { role: 'assistant', content: wire(FEW_SHOT_ACTION_RESPONSE) },
];

export function buildMessages(req: SuggestRequest): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...FEW_SHOTS,
    { role: 'user', content: JSON.stringify(req) },
  ];
}
