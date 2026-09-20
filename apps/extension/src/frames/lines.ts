import type { FrameLine } from './protocol';
import { FRAME_MAX_INDENT } from './protocol';

/**
 * A rendered outline read back into lines, so a child frame can hand the top
 * what it built rather than only the controls in it. The child renders its
 * page with the same builder the top uses, and this takes that text apart
 * again: two spaces of indent per level, `[n] ` in front of a control, the
 * focus marker in front of that, and the parenthesised notes about what is
 * off screen on their own lines at the left margin.
 *
 * The top wants those lines with their kinds, so its budget can give up the
 * child's prose before anyone's controls, and the builder hands out a
 * string. Reading the string back is the join between the two. The day the
 * builder returns its lines instead, this file goes.
 */

/** A note the renderer wrote about the page rather than a line of the page. */
const NOTE = /^\(.*\)$/;
/** The two of those worth carrying up: how far the child is scrolled, and how much of it is left. */
const SCREENS = /screens (above|below)/;
const FOCUS_MARK = '>> FOCUSED ';
const CONTROL = /^\[(\d+)\]\s+/;
const HEADING = /^h[1-6] /;

export interface ParsedOutline {
  lines: FrameLine[];
  /** The child's viewport notes, in the order the renderer wrote them. */
  summary: string[];
}

export function parseOutline(outline: string, max: number): ParsedOutline {
  const lines: FrameLine[] = [];
  const summary: string[] = [];
  for (const raw of outline.split('\n')) {
    if (!raw.trim()) continue;
    const indent = Math.min(Math.floor((raw.length - raw.trimStart().length) / 2), FRAME_MAX_INDENT);
    let text = raw.trimStart();
    if (text.startsWith(FOCUS_MARK)) text = text.slice(FOCUS_MARK.length);
    if (indent === 0 && NOTE.test(text)) {
      // The count of lines the child trimmed is the child's business; the top keeps its own.
      if (SCREENS.test(text)) summary.push(text);
      continue;
    }
    if (lines.length >= max) continue;
    const control = CONTROL.exec(text);
    if (control) {
      lines.push({ kind: 'control', indent, n: Number(control[1]) });
      continue;
    }
    lines.push({ kind: kindOf(text), indent, text });
  }
  return { lines, summary };
}

function kindOf(text: string): 'struct' | 'heading' | 'text' | 'option' {
  if (text.startsWith('text: ') || text.startsWith('image: ')) return 'text';
  if (text.startsWith('option ')) return 'option';
  if (HEADING.test(text)) return 'heading';
  // `main:`, `region "Filters":`, `form "Checkout":` — a container opening its lines.
  return text.endsWith(':') ? 'struct' : 'text';
}
