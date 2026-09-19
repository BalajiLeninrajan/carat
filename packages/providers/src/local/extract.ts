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

export function extractPhone(text: string): string | null {
  return PHONE.exec(text)?.[0]?.trim() ?? null;
}

export function extractAddress(text: string): string | null {
  return ADDRESS.exec(text)?.[0]?.trim() ?? null;
}

/** Best place-name candidate: planned "at <Place>" first, then a short quoted name, then "<Title Case> <place noun>". */
export function extractPlace(text: string): Place | null {
  for (const m of text.matchAll(PLAN_AT)) {
    const name = cleanName(m[2]!);
    if (name.length >= 3) return { name, activity: m[1]!.toLowerCase() };
  }
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
