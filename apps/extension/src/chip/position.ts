import { viewportRect } from '../scroll';

export interface ChipPlacement {
  top: number;
  left: number;
  visible: boolean;
}

const GAP = 6;
const MARGIN = 8;

/**
 * Where the chip sits for a target box: centred on it, under it when that
 * fits and else above, clamped to the window. `rect` defaults to the target's
 * own box in the top window's coordinates; a frame target passes the box it
 * worked out itself.
 */
export function placeChip(target: Element, chipWidth: number, chipHeight: number, rect: DOMRect = viewportRect(target, window)): ChipPlacement {
  return placeAt(rect, chipWidth, chipHeight, window.innerWidth, window.innerHeight);
}

export function placeAt(rect: DOMRect, chipWidth: number, chipHeight: number, vw: number, vh: number): ChipPlacement {
  // A control scrolled off any edge is one the pill has no business sitting by.
  const onScreen = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  if (!onScreen) return { top: 0, left: 0, visible: false };

  const fitsBelow = rect.bottom + GAP + chipHeight <= vh;
  const top = fitsBelow ? rect.bottom + GAP : Math.max(MARGIN, rect.top - GAP - chipHeight);
  // The pill, the ring and the control share one centre line, so the offer
  // reads as belonging to the control rather than as a note beside it.
  const centred = rect.left + rect.width / 2 - chipWidth / 2;
  const left = Math.max(MARGIN, Math.min(centred, Math.max(MARGIN, vw - chipWidth - MARGIN)));
  return { top, left, visible: true };
}

/**
 * A field inside a cross-origin frame: its box is the frame element's box
 * plus the box the frame reported for the field, clipped to the frame, since
 * a field scrolled out of the frame's own viewport is not on screen either.
 */
export function anchorInFrame(frame: DOMRect, inner: { x: number; y: number; w: number; h: number }): DOMRect {
  const left = Math.max(frame.left, frame.left + inner.x);
  const top = Math.max(frame.top, frame.top + inner.y);
  const right = Math.min(frame.right, frame.left + inner.x + inner.w);
  const bottom = Math.min(frame.bottom, frame.top + inner.y + inner.h);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
