/** Destinations carat knows how to build a URL for. The model names one; it never writes the URL. */
export const INTENTS = ['maps', 'calendar', 'gmail'] as const;
export type IntentName = (typeof INTENTS)[number];

export function isIntentName(v: unknown): v is IntentName {
  return typeof v === 'string' && (INTENTS as readonly string[]).includes(v);
}

/** The entity the model named; the registry turns it into a URL. */
export interface IntentEntity {
  value: string;
  when: string;
  location: string;
}

export interface IntentSpec {
  site: string; // "Google Maps"
  openLabel: string; // chip text for a new tab
  focusLabel: string; // chip text for an existing tab
  /** True when a tab at `url` already shows this destination. */
  isDestination(url: URL): boolean;
  /** The URL to open, or null when the entity is not enough to build one. */
  buildUrl(entity: IntentEntity): string | null;
}

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const ISO_START = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;
const DEFAULT_EVENT_MS = 60 * 60_000;

function q(params: Record<string, string>): string {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '')).toString();
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * Google Calendar's `dates` parameter, in the wall-clock time the text meant
 * (no zone suffix, so the calendar places it in the user's own zone). A
 * date without a time becomes an all-day event.
 */
export function calendarDates(when: string): string | null {
  const m = ISO_START.exec(when.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const start = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0));
  if (Number.isNaN(start)) return null;
  const allDay = h === undefined;
  const end = new Date(start + (allDay ? 24 * 60 * 60_000 : DEFAULT_EVENT_MS));
  const stamp = (t: Date) =>
    `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
    (allDay ? '' : `T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00`);
  return `${stamp(new Date(start))}/${stamp(end)}`;
}

export const INTENT_REGISTRY: Record<IntentName, IntentSpec> = {
  maps: {
    site: 'Google Maps',
    openLabel: 'Open in Google Maps',
    focusLabel: 'Switch to Google Maps',
    isDestination: (url) =>
      url.host === 'maps.google.com' ||
      url.host === 'maps.app.goo.gl' ||
      ((url.host === 'www.google.com' || url.host === 'google.com') && url.pathname.startsWith('/maps')),
    buildUrl: ({ value }) => {
      const query = value.trim();
      return query ? `https://www.google.com/maps/search/?api=1&${q({ query })}` : null;
    },
  },
  calendar: {
    site: 'Google Calendar',
    openLabel: 'Add to Google Calendar',
    focusLabel: 'Switch to Google Calendar',
    isDestination: (url) => url.host === 'calendar.google.com',
    buildUrl: ({ value, when, location }) => {
      const text = value.trim();
      if (!text) return null;
      const dates = calendarDates(when) ?? '';
      return `https://calendar.google.com/calendar/render?action=TEMPLATE&${q({ text, dates, location: location.trim() })}`;
    },
  },
  gmail: {
    site: 'Gmail',
    openLabel: 'Compose in Gmail',
    focusLabel: 'Switch to Gmail',
    isDestination: (url) => url.host === 'mail.google.com',
    buildUrl: ({ value }) => {
      const to = value.trim();
      return EMAIL.test(to) ? `https://mail.google.com/mail/?view=cm&fs=1&${q({ to })}` : null;
    },
  },
};

export function buildIntentUrl(intent: IntentName, entity: IntentEntity): string | null {
  return INTENT_REGISTRY[intent].buildUrl(entity);
}

/** True when `url` (a tab URL or "https://host/path") already shows the intent's destination. */
export function isIntentDestination(intent: IntentName, url: string | URL): boolean {
  try {
    return INTENT_REGISTRY[intent].isDestination(typeof url === 'string' ? new URL(url) : url);
  } catch {
    return false;
  }
}

export function intentLabel(intent: IntentName, kind: 'open' | 'focus'): string {
  const spec = INTENT_REGISTRY[intent];
  return kind === 'open' ? spec.openLabel : spec.focusLabel;
}

export interface ResolvedIntent {
  intent: IntentName;
  entity: IntentEntity;
  url: string;
}

/**
 * What an `open` action's `value` means. The model names a destination and
 * the thing to look up, never a URL: `maps:Seven Shores Cafe`, or
 * `calendar:Dinner at Seven Shores Cafe|2026-09-18T18:00|Seven Shores Cafe`
 * when it has a time and a place too. Anything else, including a URL the
 * model wrote out, resolves to null and the action is refused.
 */
export function resolveIntentValue(value: string): ResolvedIntent | null {
  const at = value.indexOf(':');
  if (at <= 0) return null;
  const intent = value.slice(0, at).trim().toLowerCase();
  if (!isIntentName(intent)) return null;
  const [name = '', when = '', location = ''] = value
    .slice(at + 1)
    .split('|')
    .map((part) => part.trim());
  const entity: IntentEntity = { value: name, when, location };
  const url = buildIntentUrl(intent, entity);
  return url ? { intent, entity, url } : null;
}
