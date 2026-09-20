// The request the engine answers and the single action it returns. Shared by
// the evidence side (content script, history, notes) and the engine side
// (prompt, providers, orchestrator, chip). Change it on both branches or not at all.
import type { Eagerness } from './eagerness';

export type ControlRole = 'textbox' | 'searchbox' | 'combobox' | 'button' | 'link' | 'checkbox' | 'radio' | 'switch' | 'slider' | 'select' | 'option' | 'tab' | 'menuitem' | 'other';

export interface OutlineControl {
  /** The number the outline shows as [n]; the model names it. */
  n: number;
  role: ControlRole;
  name: string;
  value?: string;
  /** required, checked, expanded, selected, disabled: whatever applies, space separated. */
  state?: string;
  /** Registrable domain a link goes to. */
  host?: string;
  /**
   * What pressing this opens, from `aria-haspopup`: `dialog`, `listbox`,
   * `menu`, `tree`, `grid` or `dialog` for a plain `true`. A date field
   * rendered as a button reads as `button "Departure date" (opens dialog)`,
   * so the model knows the click is a step towards a value, not a submit.
   */
  popup?: string;
  /** Frame id when the control lives in a child frame; the top frame performs through the hub. */
  fr?: number;
  /** A label that names payment, sending, deleting or the like; a backstop for the model's irreversible flag. */
  risky?: boolean;
}

export interface PageScroll {
  /** Scroll position in viewports, one decimal. */
  y: number;
  /** Document height in viewports, one decimal. */
  pages: number;
  /** A viewport down would show something new. */
  more: boolean;
}

export interface OpenTab {
  id: number;
  host: string;
  title: string;
}

export interface NextActionRequest {
  page: { host: string; title: string; path: string; scroll: PageScroll };
  /** The page as text: landmarks indented, text inline, controls numbered [n] with role, name, value, state; the focused one marked. At most 9000 chars, trimmed by distance from focus. */
  outline: string;
  /** Index of the numbered controls in the outline, for the model's schema and for performing. */
  controls: OutlineControl[];
  /** n of the focused control, if any. */
  focused?: number;
  /** Per-tab timeline, oldest first, at most 12 lines like "40s ago: clicked button \"Add to cart\"". */
  history: string[];
  /** Distilled facts from pages read recently in other tabs, newest first, at most 8. */
  notes: string[];
  /**
   * One line for what the user is trying to get done across tabs, at most 120
   * chars, in their own terms. Absent when carat has not worked one out. It
   * sits inside the cached prefix, so a goal that changes costs one cache miss.
   */
  goal?: string;
  /** Open tabs the user could switch to. */
  tabs: OpenTab[];
  now: string;
  eagerness: Eagerness;
}

/**
 * What a scroll offer says. The first one on a page is `Scroll down`; from
 * anywhere below the top it is `Scroll more`, because the user has already
 * taken one. A label the model wrote is never replaced by this.
 */
export function scrollLabel(scroll: PageScroll): string {
  return scroll.y > 0 ? 'Scroll more' : 'Scroll down';
}

export type NextActionKind = 'fill' | 'click' | 'select' | 'scroll' | 'open' | 'switch' | 'none';

export interface NextAction {
  kind: NextActionKind;
  /** Control n for fill/click/select; null for scroll, open, switch and none. */
  target: number | null;
  /** The value for fill/select; a URL for open; a tab id as a string for switch; '' otherwise. */
  value: string;
  /** Chip text, in the imperative, at most 60 chars: 'Open "Waterloo to McMaster"', 'Fill Search Google Maps with "Seven Shores Cafe"'. */
  label: string;
  /** Sending, paying, deleting, submitting an order: the chip arms on the first Tab and acts on the second. */
  irreversible: boolean;
  confidence: number;
  /** One short clause for the tooltip. */
  reason: string;
  /**
   * Where a fill's value came from, worded for the chip's hover preview:
   * `from discord.com: dinner at Seven Shores Cafe, Friday at 6?`. The
   * service worker derives it from the notes and the timeline; the model
   * never writes it.
   */
  source?: string;
  /** Where an `open` or a `switch` leads, for the same preview. */
  destination?: { host: string; title?: string };
  /**
   * Not an offer: the model answered, carat could not carry the answer out,
   * and this is the model's own label shown as a greyed line the user can
   * only dismiss. It exists so a refusal is visible as a refusal instead of
   * being dressed up as some plainer step the user never asked for. `kind`
   * is always `none`, `target` always null, and nothing ever performs it.
   */
  hint?: boolean;
}

/** What the chip says over a refused answer: `Carat wanted: Fill From with "Toronto"`. */
export function hintLabel(label: string): string {
  return `Carat wanted: ${label}`;
}
