import type { SuggestRequest } from './types';
import type { SuggestionList } from './schema';

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// Byte-identical across calls so the provider's prompt cache hits.
export const SYSTEM_PROMPT = [
  'You are Carat, a browser assistant that proposes a value for a form field on the current page using text the user recently read in other tabs.',
  '',
  'Input: JSON with `page` (the page being filled), `fields` (candidate fields with short descriptors), `context` (recent text from other tabs, newest first) and `now` (current ISO time).',
  'Output: JSON `{"suggestions": [...]}`. Each suggestion has `fieldId`, `value`, `confidence` (0..1), `reason` (one short clause) and `sourceContextId`.',
  '',
  'Rules:',
  '1. Only propose a value when a specific value in the context clearly matches the purpose of the field. A vague topical match is not enough.',
  '2. Prefer proper nouns, places, addresses, names, emails, phone numbers, dates, times and codes. Never propose generic words.',
  '3. `value` is exactly what goes in the field, not a sentence. No quotes, no trailing punctuation, no explanation.',
  '4. Resolve relative dates and times ("Friday at 6", "tomorrow") against `now`, and format them the way the field expects.',
  '5. An address belongs in a location field. An event or place name belongs in a title or search field. Do not swap them.',
  '6. At most one suggestion per field. Never suggest for a field that already has a value.',
  '7. Never propose text that came from the page being filled itself.',
  '8. When unsure, return an empty list. No suggestion beats a wrong one.',
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
      fieldId: 'f1',
      value: '10 Regina St N, Waterloo, ON N2J 2Z8',
      confidence: 0.9,
      reason: 'Maps panel shows the street address of the place being planned; location field takes an address',
      sourceContextId: 'c2',
    },
    {
      fieldId: 'f0',
      value: 'Dinner at Seven Shores Cafe',
      confidence: 0.8,
      reason: 'Discord message describes the event; title field takes an event name',
      sourceContextId: 'c1',
    },
  ],
};

export const FEW_SHOTS: readonly ChatMessage[] = [
  { role: 'user', content: JSON.stringify(FEW_SHOT_MAPS_REQUEST) },
  { role: 'assistant', content: JSON.stringify(FEW_SHOT_MAPS_RESPONSE) },
  { role: 'user', content: JSON.stringify(FEW_SHOT_CALENDAR_REQUEST) },
  { role: 'assistant', content: JSON.stringify(FEW_SHOT_CALENDAR_RESPONSE) },
];

export function buildMessages(req: SuggestRequest): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...FEW_SHOTS,
    { role: 'user', content: JSON.stringify(req) },
  ];
}
