// Regex extraction for the offline provider. Every pattern is deliberately
// narrow: a missed suggestion costs nothing, a wrong one costs trust.

export interface Place {
  name: string;
  /** Activity noun preceding "at <place>", e.g. "dinner"; used to build an event title. */
  activity?: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// The lookbehind stops the tail of a long number (timestamp, order id) reading as a phone.
const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

const STREET_SUFFIX =
  'St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Way|Ln|Lane|Ct|Court|Pl|Place|Cres|Crescent|Pkwy|Parkway|Hwy|Highway|Terr|Terrace|Sq|Square|Trail|Cir|Circle';
const DIRECTION = 'N|S|E|W|NE|NW|SE|SW|North|South|East|West';
const POSTAL = '[A-Z]\\d[A-Z] ?\\d[A-Z]\\d|\\d{5}(?:-\\d{4})?';
const ADDRESS = new RegExp(
  `\\b\\d{1,6}[A-Za-z]?(?:-\\d{1,6})?\\s+(?:[A-Z][\\w'.-]*\\s+){1,4}(?:${STREET_SUFFIX})\\b\\.?` +
    `(?:\\s+(?:${DIRECTION})\\b\\.?)?` +
    `(?:,\\s*[A-Z][a-z.]+(?:\\s[A-Z][a-z.]+)*(?:,\\s*[A-Z]{2})?(?:\\s+(?:${POSTAL}))?)?`,
);

const ACTIVITY =
  'dinner|lunch|brunch|breakfast|coffee|drinks|beers?|meet(?:ing|up)?|hang(?:out)?|party|movie|game|practice|see you';
// Only the activity cue may be capitalised either way; the regex itself stays
// case-sensitive so CAP_WORD really means a capital. "be" is not a cue: news
// prose says "will be at Queen's Park" with no plan behind it.
const ACTIVITY_ANY_CASE = ACTIVITY.replace(/\b([a-z])/g, (c) => `[${c.toUpperCase()}${c}]`);
const CAP_WORD = "[A-Z][\\w'&.-]*";
const NAME_TAIL = `(?:\\s+(?:${CAP_WORD}|of|the|and|&|de|du|la|le))*`;
// "dinner at Seven Shores Cafe, Friday at 6?" -> Seven Shores Cafe. The
// activity cue keeps "voted at City Hall on Tuesday" in a news story out.
const PLAN_AT = new RegExp(`\\b(${ACTIVITY_ANY_CASE})\\b[^.?!,\\n]{0,24}?\\bat\\s+(${CAP_WORD}${NAME_TAIL})`, 'g');
const QUOTED = /["“]([^"”\n]{3,60})["”]/g;
const PLACE_NOUN =
  'Cafe|Café|Coffee|Restaurant|Bar|Pub|Bistro|Grill|Kitchen|Bakery|Pizzeria|Diner|Brewery|Park|Library|Museum|Theatre|Theater|Arena|Stadium|Centre|Center|Hall|Hotel|Market|Plaza|Mall|Gallery|Club|Lounge|Tavern|Eatery|Deli|Gardens?|Station';
const EVENT_NOUN =
  'Festival|Fest|Carnival|Parade|Concert|Conference|Summit|Expo|Marathon|Gala|Fair|Tournament|Workshop|Meetup|Hackathon|Showcase|Oktoberfest';
const TITLE_CASE_PLACE = new RegExp(`\\b((?:${CAP_WORD}\\s+){1,4}(?:${PLACE_NOUN}))\\b`, 'g');
const TITLE_CASE_EVENT = new RegExp(`\\b((?:${CAP_WORD}\\s+){0,4}(?:${EVENT_NOUN})(?:\\s+\\d{4})?)\\b`, 'g');

// Whole words only: "Sunset Grill" and "Golden Monkey" are names, not times.
const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day|sday|nesday|rsday|urday|rs|s)?';
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:uary|ruary|ch|il|e|y|ust|tember|t|ober|ember)?';
const TIME_WORD = new RegExp(`\\s+(?:${DAY}|${MONTH}|Tonight|Tomorrow|Today|Next|This)\\b.*$`);
const TRAILING_FILLER = /\s+(?:of|the|and|&|de|du|la|le)$/i;

function cleanName(raw: string): string {
  return raw.replace(TIME_WORD, '').replace(TRAILING_FILLER, '').trim();
}

export function extractEmail(text: string): string | null {
  return EMAIL.exec(text)?.[0] ?? null;
}

const EMAIL_ALL = new RegExp(EMAIL.source, 'g');
// "can you email them? her address is x@y" asks for a message; a footer's
// "Contact: tips@cbc.ca" does not.
const EMAIL_CUE = /\b(?:e-?mail(?:ing|ed|s)?|send|forward|write to|reach (?:her|him|them|me|us|out)|address is)\b/i;

/** An email address the text asks the reader to write to, judged by a cue in the 60 chars before it. */
export function extractEmailRequest(text: string): string | null {
  for (const m of text.matchAll(EMAIL_ALL)) {
    if (EMAIL_CUE.test(text.slice(Math.max(0, m.index - 60), m.index))) return m[0];
  }
  return null;
}

export function extractPhone(text: string): string | null {
  return PHONE.exec(text)?.[0]?.trim() ?? null;
}

export function extractAddress(text: string): string | null {
  return ADDRESS.exec(text)?.[0]?.trim() ?? null;
}

export interface Plan extends Place {
  activity: string;
  /** Offset just past the place name, where a time for the plan would follow. */
  end: number;
}

/** The first planned "<activity> at <Place>" in the text, with where it ends. */
export function extractPlan(text: string): Plan | null {
  for (const m of text.matchAll(PLAN_AT)) {
    const name = cleanName(m[2]!);
    if (name.length >= 3) return { name, activity: m[1]!.toLowerCase(), end: m.index + m[0].length };
  }
  return null;
}

/** Best place-name candidate: planned "at <Place>" first, then a short quoted name, then "<Title Case> <place noun>". */
export function extractPlace(text: string): Place | null {
  const plan = extractPlan(text);
  if (plan) return { name: plan.name, activity: plan.activity };
  for (const m of text.matchAll(QUOTED)) {
    const q = m[1]!.trim();
    const words = q.split(/\s+/);
    // Quoted dialogue ends in sentence punctuation or a comma before "said"; a name does not.
    if (words.length <= 6 && /[A-Z]/.test(q) && !/[.!?,;:]$/.test(q)) return { name: q };
  }
  const place = TITLE_CASE_PLACE.exec(text);
  TITLE_CASE_PLACE.lastIndex = 0;
  return place ? { name: place[1]!.trim() } : null;
}

/** A named event ("Waterloo Busker Carnival", "Oktoberfest 2026") for title fields. */
export function extractEvent(text: string): string | null {
  const m = TITLE_CASE_EVENT.exec(text);
  TITLE_CASE_EVENT.lastIndex = 0;
  return m ? m[1]!.trim() : null;
}

// "Friday at 6", "fri @ 6:30", "tomorrow 7pm", "tonight at 9". A bare "Friday 6"
// is not a time (six people, six dollars), so one of at/@, :MM or am/pm is required.
const WHEN = new RegExp(
  `\\b(sun|mon|tue|wed|thu|fri|sat|today|tonight|tomorrow)(?:day|sday|nesday|rsday|urday|rs|s)?\\b[,\\s]*` +
    `(?:(at\\s+|@\\s*))?(\\d{1,2})(?:(:)(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?(?![\\d:])`,
  'i',
);
const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MORNING = new Set(['breakfast', 'brunch', 'coffee']);
const OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The first day-plus-time phrase in `text`, resolved against `now` (ISO with
 * offset) to the next such moment, as ISO in the same offset. `activity` only
 * settles am/pm when the text does not: coffee at 9 is morning, anything else
 * without a marker is afternoon or evening.
 */
export function extractWhen(text: string, now: string, activity?: string): string | null {
  const m = WHEN.exec(text);
  if (!m) return null;
  const [, dayWord, at, hourText, colon, minuteText, meridiem] = m;
  if (!at && !colon && !meridiem) return null;
  const instant = Date.parse(now);
  if (Number.isNaN(instant)) return null;
  const offsetMin = parseOffset(now);
  const local = new Date(instant + offsetMin * 60_000); // wall clock as UTC fields

  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (hour > 23 || minute > 59) return null;
  const marker = meridiem?.[0]?.toLowerCase();
  if (marker === 'a' && hour === 12) hour = 0;
  else if (marker === 'p' && hour < 12) hour += 12;
  else if (!marker && hour < 12 && hour !== 0) {
    const morning = activity !== undefined && MORNING.has(activity) && hour >= 6;
    if (!morning) hour += 12;
  }

  const word = dayWord!.toLowerCase().slice(0, 3);
  let days: number;
  if (word === 'tod' || word === 'ton') days = 0;
  else if (word === 'tom') days = 1;
  else {
    days = (DOW[word]! - local.getUTCDay() + 7) % 7;
    const passed = hour * 60 + minute <= local.getUTCHours() * 60 + local.getUTCMinutes();
    if (days === 0 && passed) days = 7;
  }
  const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour, minute));
  return formatLocalIso(target, offsetMin);
}

function parseOffset(iso: string): number {
  const m = OFFSET.exec(iso.trim());
  if (!m || m[1] === 'Z') return 0;
  const sign = m[1]!.startsWith('-') ? -1 : 1;
  const digits = m[1]!.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
}

function formatLocalIso(wall: Date, offsetMin: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return (
    `${wall.getUTCFullYear()}-${p(wall.getUTCMonth() + 1)}-${p(wall.getUTCDate())}` +
    `T${p(wall.getUTCHours())}:${p(wall.getUTCMinutes())}:00${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}
