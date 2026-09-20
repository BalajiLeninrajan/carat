import type { OutlineControl } from '@carat/shared';
import type { AcceptKey, RelayedKey } from '../chip';
import type { FillOutcome } from '../fill';

/**
 * How a content script in a cross-origin child frame talks to the one in the
 * top frame, over `postMessage`. The top frame owns the one chip and the
 * conversation with the service worker; a child frame only describes what
 * it has, performs one thing when asked, and relays the keys it hears while
 * a chip is up for one of its fields.
 *
 * A child describes itself the way the top describes a page, in outline
 * lines with the prose left in. A comment widget or an embedded article is
 * mostly text, and a frame that reported nothing but buttons read to the
 * model as a form with no question on it. Nothing beyond that outline
 * crosses: no settings, no key, and no URL but the child's own host, for
 * the line the top writes above its lines.
 */
export const FRAME_MARK = 'carat-frame';
export const FRAME_VERSION = 1;

/**
 * Characters of the parent's outline one child frame builds against. The top
 * trims what it splices in by distance from the focus like any other region,
 * so this is only a first cut at the child's end, where the parent's budget
 * is not known.
 */
export const FRAME_BUDGET = 2000;
/** Lines one frame may contribute, and how deep their nesting is kept. */
export const FRAME_MAX_LINES = 60;
export const FRAME_MAX_INDENT = 4;

/** A control that lives in a child frame: the registry element is the frame element, and the child performs. */
export interface FrameRef {
  token: string;
  remoteId: string;
}

/** A box in the child frame's own viewport coordinates. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One line of a child frame's outline, for the top to splice in under the frame's own line. */
export type FrameLineKind = 'struct' | 'heading' | 'text' | 'option';
export type FrameLine =
  /** Prose, a heading, a region's opening line or a select's option, already rendered by the child. */
  | { kind: FrameLineKind; indent: number; text: string }
  /** One of the report's controls, in the place the child put it. The top renders and renumbers it. */
  | { kind: 'control'; indent: number; n: number };

/** Everything the top frame needs to stand in for the child's own outline. */
export interface FrameReport {
  /** The frame's own outline controls, numbered in its own space; the top splices them in with `fr` set. */
  controls: OutlineControl[];
  /**
   * The frame's outline in order, prose included, indented relative to the
   * frame's own line. Absent from a child too old to send it, and the top
   * then falls back to listing `controls` alone.
   */
  lines?: FrameLine[];
  /**
   * The child's own `(1.2 more screens below)` notes, sent only when the
   * frame scrolls independently of the page around it. A frame sized to its
   * content has nothing of its own below the fold to say.
   */
  summary?: string[];
  /** The child's host, for the line the top writes above its lines. */
  host?: string;
  /** Per control number (as a string), where it sits inside the frame, so the top can anchor a chip over it. */
  rects: Record<string, Box>;
}

/** One action on one outline control, named by the number the frame itself gave it. */
export type PerformRequest = { kind: 'outline'; n: number; action: 'fill' | 'click' | 'select'; value: string; host?: string; locale?: string };

export interface PerformReply {
  ok: boolean;
  outcome?: FillOutcome;
}

export type ToTop =
  | { carat: typeof FRAME_MARK; v: typeof FRAME_VERSION; type: 'report'; token: string; reply: boolean; report: FrameReport }
  | { carat: typeof FRAME_MARK; v: typeof FRAME_VERSION; type: 'performed'; token: string; seq: number; reply: PerformReply }
  | { carat: typeof FRAME_MARK; v: typeof FRAME_VERSION; type: 'key'; token: string; key: RelayedKey };

export type ToChild =
  | { carat: typeof FRAME_MARK; v: typeof FRAME_VERSION; type: 'snapshot' }
  | { carat: typeof FRAME_MARK; v: typeof FRAME_VERSION; type: 'perform'; seq: number; req: PerformRequest }
  | { carat: typeof FRAME_MARK; v: typeof FRAME_VERSION; type: 'arm'; key: AcceptKey }
  | { carat: typeof FRAME_MARK; v: typeof FRAME_VERSION; type: 'disarm' };

export function isFrameMessage(data: unknown): data is ToTop | ToChild {
  if (!data || typeof data !== 'object') return false;
  const d = data as { carat?: unknown; v?: unknown; type?: unknown };
  return d.carat === FRAME_MARK && d.v === FRAME_VERSION && typeof d.type === 'string';
}

export function stamp<T extends object>(body: T): T & { carat: typeof FRAME_MARK; v: typeof FRAME_VERSION } {
  return { carat: FRAME_MARK, v: FRAME_VERSION, ...body };
}

/** Frame elements are looked for this many open shadow roots down, and this many elements in. */
export const FRAME_SHADOW_DEPTH = 8;
const FRAME_SCAN_NODES = 20_000;

/**
 * Every frame element in the document, light DOM and open shadow roots
 * together, in the order a walk meets them: a host's root comes right after
 * the host. The outline walks into open shadow roots, so a frame inside a
 * component is described like any other, and the hub has to be able to match
 * a report to it and number it. A closed root is opaque here as it is there.
 */
export function frameElements(doc: Document): Element[] {
  const out: Element[] = [];
  let seen = 0;
  const scan = (root: Document | ShadowRoot, depth: number): void => {
    for (const el of root.querySelectorAll('*')) {
      if (seen++ > FRAME_SCAN_NODES) return;
      const tag = el.tagName.toLowerCase();
      if (tag === 'iframe' || tag === 'frame') out.push(el);
      const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow && depth < FRAME_SHADOW_DEPTH) scan(shadow, depth + 1);
    }
  };
  scan(doc, 0);
  return out;
}

/**
 * A frame's number in the top document: its position among the frame
 * elements, one-based, so the model sees `fr: 1` on every field of the first
 * embedded form. Consistent within one snapshot, which is all it needs to be.
 */
export function frameNumber(doc: Document, iframe: Element): number {
  return frameElements(doc).indexOf(iframe) + 1;
}
