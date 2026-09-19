import type { OutlineControl } from '@carat/shared';
import type { AcceptKey, RelayedKey } from '../chip';
import type { FillOutcome } from '../fill';

/**
 * How a content script in a cross-origin child frame talks to the one in the
 * top frame, over `postMessage`. The top frame owns the one chip and the
 * conversation with the service worker; a child frame only describes what
 * it has, performs one thing when asked, and relays the keys it hears while
 * a chip is up for one of its fields. Nothing in here carries page text, a
 * URL or anything from settings beyond what the descriptors already hold.
 */
export const FRAME_MARK = 'carat-frame';
export const FRAME_VERSION = 1;

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

/** Everything the top frame needs to stand in for the child's own outline. */
export interface FrameReport {
  /** The frame's own outline controls, numbered in its own space; the top splices them in with `fr` set. */
  controls: OutlineControl[];
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

/**
 * A frame's number in the top document: its position among the frame
 * elements, one-based, so the model sees `fr: 1` on every field of the first
 * embedded form. Consistent within one snapshot, which is all it needs to be.
 */
export function frameNumber(doc: Document, iframe: Element): number {
  return Array.from(doc.querySelectorAll('iframe,frame')).indexOf(iframe) + 1;
}
