export interface ChipPlacement {
  top: number;
  left: number;
  visible: boolean;
}

const GAP = 6;
const MARGIN = 8;

export function placeChip(target: Element, chipWidth: number, chipHeight: number): ChipPlacement {
  const rect = target.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const onScreen = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < vh;
  if (!onScreen) return { top: 0, left: 0, visible: false };

  const fitsBelow = rect.bottom + GAP + chipHeight <= vh;
  const top = fitsBelow ? rect.bottom + GAP : Math.max(MARGIN, rect.top - GAP - chipHeight);
  const left = Math.min(Math.max(MARGIN, rect.left), Math.max(MARGIN, vw - chipWidth - MARGIN));
  return { top, left, visible: true };
}
