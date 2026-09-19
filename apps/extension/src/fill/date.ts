import { normalizeWhitespace } from '@carat/shared';
import { isVisible } from '../capture/visibility';
import { isInput } from '../dom/tags';
import { labelOf } from '../snapshot/labels';
import type { TextControl } from './text';
import { fillTextControl } from './text';
import { pressPointer, tick, waitFor } from './wait';

/** How long a date field gets to open its calendar, and how many month turns are tried before giving up. */
export const DATE_TIMING = { gridCapMs: 600, stepMs: 60, maxMonthSteps: 12 } as const;

export type DateOutcome = 'done' | 'partial';

export interface DateParts {
  y: number;
  m: number; // 1..12
  d: number;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/;
const HAS_YEAR = /\b(?:19|20)\d{2}\b/;
// A placeholder that spells out its format: dd/mm/yyyy, MM-DD-YYYY, yyyy.mm.dd, d/m/yy.
const FORMAT_PLACEHOLDER = /\b([dmy]{1,4})([\/.\-\s])([dmy]{1,4})\2([dmy]{2,4})\b/i;
const DATE_HINT = /\b(?:date|depart(?:ure|ing)?|return(?:ing)?|check[\s-]?in|check[\s-]?out|birth(?:day|date)?|dob|travel(?:ling)? on|when)\b/i;
const NEXT = /\bnext\b|\bforward\b|›|»|→/i;
const PREV = /\bprev(?:ious)?\b|\bback\b|‹|«|←/i;

/**
 * A calendar date out of what the model wrote: ISO (with or without a time
 * and offset), anything `Date.parse` reads ("Sep 26, 2026", "26 September
 * 2026"), or a month and day with no year, which means the next such date.
 */
export function parseDate(value: string, now: Date = new Date()): DateParts | null {
  const text = normalizeWhitespace(value);
  const iso = ISO.exec(text);
  if (iso) return checked({ y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) });
  if (!/\d/.test(text)) return null;
  const withYear = HAS_YEAR.test(text);
  const parsed = new Date(withYear ? text : `${text} ${now.getFullYear()}`);
  if (Number.isNaN(parsed.getTime())) return null;
  let parts: DateParts = { y: parsed.getFullYear(), m: parsed.getMonth() + 1, d: parsed.getDate() };
  if (!withYear) {
    // "Sep 26" said in October means next September: a date to book, not one that passed.
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (parsed < today) parts = { ...parts, y: parts.y + 1 };
  }
  return checked(parts);
}

function checked(p: DateParts): DateParts | null {
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31 || p.y < 1900 || p.y > 2100) return null;
  return p;
}

/** A field that wants a date: `type=date`, a placeholder that spells a format, or a label like Departure, Return, Check-in. */
export function isDateField(el: Element): boolean {
  if (isInput(el) && el.type === 'date') return true;
  const ph = el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? '';
  if (FORMAT_PLACEHOLDER.test(ph)) return true;
  const hints = [ph, el.getAttribute('aria-label'), el.getAttribute('name'), el.id, labelOf(el, el.ownerDocument)].filter((h): h is string => !!h);
  return hints.some((h) => DATE_HINT.test(h));
}

/**
 * The text the field expects: ISO for `type=date`, whatever the placeholder
 * spells out, else the locale's numeric short date, which is what the
 * field's own users type.
 */
export function formatDate(p: DateParts, el: Element, locale?: string): string {
  const iso = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  if (isInput(el) && el.type === 'date') return iso;
  const ph = el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? '';
  const spelled = FORMAT_PLACEHOLDER.exec(ph);
  if (spelled) {
    const sep = spelled[2]!;
    return [spelled[1]!, spelled[3]!, spelled[4]!].map((token) => tokenValue(token, p)).join(sep);
  }
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(p.y, p.m - 1, p.d));
  } catch {
    return iso;
  }
}

function tokenValue(token: string, p: DateParts): string {
  const t = token.toLowerCase();
  if (t.startsWith('y')) return t.length <= 2 ? pad(p.y % 100) : String(p.y);
  if (t.startsWith('m')) return t.length >= 2 ? pad(p.m) : String(p.m);
  return t.length >= 2 ? pad(p.d) : String(p.d);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Type the date into the input in the format it expects, through the same setter as any text. */
export function fillDateInput(el: TextControl, p: DateParts, locale?: string): void {
  fillTextControl(el, formatDate(p, el, locale));
}

/**
 * Many date fields open a `role=grid` calendar on focus and only take a date
 * from a click in it. If one shows up within the cap, turn its month buttons
 * until the target month is on show, then press the cell named for the day.
 * No grid means the typed text was the whole job. A grid that never reaches
 * the month, or has no cell for the day, leaves the text and reports
 * `partial`.
 */
export async function pickFromCalendar(input: Element, p: DateParts, doc: Document = input.ownerDocument): Promise<DateOutcome> {
  const grid = await waitFor(doc, () => findGrid(input, doc), DATE_TIMING.gridCapMs);
  if (!grid) return 'done';
  for (let step = 0; step <= DATE_TIMING.maxMonthSteps; step++) {
    const cell = findCell(grid, p);
    if (cell) {
      pressPointer(cell.matches('button,[role="button"]') ? cell : (cell.querySelector('button,[role="button"]') ?? cell));
      return 'done';
    }
    const shownMonth = monthOnShow(grid);
    const direction = shownMonth === null ? 1 : Math.sign(p.y * 12 + p.m - (shownMonth.y * 12 + shownMonth.m));
    if (direction === 0) return 'partial';
    const nav = navButton(grid, direction > 0 ? NEXT : PREV);
    if (!nav) return 'partial';
    pressPointer(nav);
    await tick(doc, DATE_TIMING.stepMs);
    if (!grid.isConnected) return 'partial';
  }
  return 'partial';
}

function findGrid(input: Element, doc: Document): Element | null {
  const ids = `${input.getAttribute('aria-controls') ?? ''} ${input.getAttribute('aria-owns') ?? ''}`.trim();
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const el = doc.getElementById(id);
    const grid = el && (el.matches('[role="grid" i]') ? el : el.querySelector('[role="grid" i]'));
    if (grid && shown(grid)) return grid;
  }
  for (const grid of doc.querySelectorAll('[role="grid" i]')) {
    if (shown(grid) && grid.querySelector('[role="gridcell" i]')) return grid;
  }
  return null;
}

/** The cell for the day: an aria-label naming month, day and year, or a data attribute holding the ISO date. */
export function findCell(grid: Element, p: DateParts): Element | null {
  const iso = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  const month = MONTHS[p.m - 1]!;
  const short = month.slice(0, 3);
  const byLabel = new RegExp(`\\b(?:${month}|${short})\\.?\\s+${p.d}(?:st|nd|rd|th)?\\b[^\\d]*\\b${p.y}\\b|\\b${p.d}(?:st|nd|rd|th)?\\s+(?:${month}|${short})\\.?\\b[^\\d]*\\b${p.y}\\b`, 'i');
  for (const cell of grid.querySelectorAll('[role="gridcell" i],td,[role="button" i],button')) {
    if (!shown(cell) || cell.getAttribute('aria-disabled') === 'true') continue;
    const label = cell.getAttribute('aria-label') ?? '';
    if (label && byLabel.test(label)) return cell;
    for (const attr of Array.from(cell.attributes)) {
      if (attr.name.startsWith('data-') && attr.value === iso) return cell;
    }
  }
  return null;
}

/** The month a grid is showing, read off its first dated cell, else null. */
function monthOnShow(grid: Element): { y: number; m: number } | null {
  for (const cell of grid.querySelectorAll('[role="gridcell" i],td,button')) {
    for (const attr of Array.from(cell.attributes)) {
      if (!attr.name.startsWith('data-')) continue;
      const m = ISO.exec(attr.value);
      if (m) return { y: Number(m[1]), m: Number(m[2]) };
    }
    const label = cell.getAttribute('aria-label')?.toLowerCase() ?? '';
    const named = MONTHS.findIndex((name) => label.includes(name));
    const year = HAS_YEAR.exec(label);
    if (named >= 0 && year) return { y: Number(year[0]), m: named + 1 };
  }
  return null;
}

/** The next or previous month button near the grid: inside its dialog, else up a few ancestors. */
function navButton(grid: Element, pattern: RegExp): Element | null {
  let scope: Element | null = grid.closest('[role="dialog" i],[role="application" i]') ?? grid.parentElement;
  for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
    for (const b of scope.querySelectorAll('button,[role="button" i]')) {
      if (grid.contains(b) || !shown(b) || b.getAttribute('aria-disabled') === 'true' || (b as HTMLButtonElement).disabled) continue;
      const label = normalizeWhitespace(`${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.textContent ?? ''}`);
      if (pattern.test(label)) return b;
    }
    if (scope.matches('[role="dialog" i]')) break;
  }
  return null;
}

function shown(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  if (el.closest('[aria-hidden="true"],[hidden]')) return false;
  return isVisible(el, win);
}
