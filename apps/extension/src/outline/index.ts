// stub: replaced by balaji/engine-evidence
//
// The DOM outline the engine reads the page from: landmarks indented, text
// inline, every control the user could operate numbered [n], the focused one
// marked. The evidence branch builds it; this stub keeps the engine side
// compiling and gives the content script the shape it codes against.
import type { OutlineControl, PageScroll } from '@carat/shared';

export interface Outline {
  /** The page as text, at most LIMITS.outlineChars, trimmed by distance from focus. */
  text: string;
  controls: OutlineControl[];
  /** n of the focused control, if any. */
  focused?: number;
  /** n to the element it names, for performing and for the ring. */
  registry: Map<number, Element>;
  scroll: PageScroll;
  /** A visible password field: the page is never read or acted on. */
  password: boolean;
}

export interface OutlineOptions {
  /** Controls inside cross-origin child frames, merged in by the hub. */
  frames?: unknown;
}

export const EMPTY_OUTLINE: Outline = {
  text: '',
  controls: [],
  registry: new Map(),
  scroll: { y: 0, pages: 1, more: false },
  password: false,
};

export function buildOutline(_doc: Document = document, _win: Window = window, _opts: OutlineOptions = {}): Outline {
  return { ...EMPTY_OUTLINE, registry: new Map() };
}
