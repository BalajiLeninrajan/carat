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
  /** Open tabs the user could switch to. */
  tabs: OpenTab[];
  now: string;
  eagerness: Eagerness;
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
}
