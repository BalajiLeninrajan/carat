/**
 * Every duration and accent the chip animates with is a custom property on
 * the shadow root, so the whole feel is tuned in one block rather than hunted
 * through keyframes. The JS reads the same numbers from `TIMING` below; keep
 * the two in step.
 *
 * The rule those numbers keep to: nothing runs longer than 200ms, nothing
 * moves further than 2px, and nothing repeats. An offer should appear and go
 * without ever being the thing you are looking at.
 */
import { RING } from '../engine/content/ring';

export const TIMING = {
  /** The fade a new chip arrives on. */
  enterMs: 120,
  /** The keycap darkening under an accepted Tab. */
  pressMs: 60,
  /** A replaced value cross-fading in place. */
  freshMs: 120,
  /** The chip fading out, whichever way the offer went. */
  exitMs: 100,
  /** The accent outline left on the control the offer acted on. */
  flashMs: 200,
} as const;

/**
 * The pill's text, and the keycap sized off it. The keycap's outer box is
 * exactly the label's line box: same font size, and whatever padding is left
 * once its border is taken off. A key that stands taller than the words next
 * to it makes the pill look like a toolbar.
 */
export const TYPE = {
  fontPx: 13,
  lineHeight: 1.25,
  /** The banner says the same things larger; the keycap follows it up. */
  bannerFontPx: 16,
} as const;

const KEYCAP_BORDER_PX = 1;

/** The padding that makes a keycap's box match the line box of `fontPx` text. */
function keycapPadY(fontPx: number): number {
  return (fontPx * TYPE.lineHeight - fontPx - KEYCAP_BORDER_PX * 2) / 2;
}

export const KEYCAP = {
  fontPx: TYPE.fontPx,
  /** `font: 600 13px/1`: the cap's own line box is its font size. */
  lineHeightPx: TYPE.fontPx,
  borderPx: KEYCAP_BORDER_PX,
  padYPx: keycapPadY(TYPE.fontPx),
  padXPx: 5,
  radiusPx: 4,
  bannerFontPx: TYPE.bannerFontPx,
  bannerLineHeightPx: TYPE.bannerFontPx,
  bannerPadYPx: keycapPadY(TYPE.bannerFontPx),
  bannerPadXPx: 7,
  bannerRadiusPx: 5,
} as const;

/**
 * Classes that only mean anything as an animation. Under
 * `prefers-reduced-motion` none of them is ever put on the pill; the static
 * states (`is-still`, `is-armed`, `is-press`) carry the meaning instead.
 */
export const KEYFRAME_CLASSES = ['is-entering', 'is-leaving'] as const;

// Inline so the chip needs no web-accessible resources and no page CSS can reach it.
export const CHIP_CSS = `
:host {
  all: initial;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483647;
  pointer-events: auto;

  /* The whole feel, in one place. */
  --carat-accent: ${RING.accent};
  --carat-amber: ${RING.armed};
  --carat-enter-ms: ${TIMING.enterMs}ms;
  --carat-fresh-ms: ${TIMING.freshMs}ms;
  --carat-exit-ms: ${TIMING.exitMs}ms;
}
.chip {
  all: initial;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  /* Narrow viewports get the same pill, just less of the label: the second
     line is an instruction and has to stay whole. */
  max-width: min(360px, calc(100vw - 24px));
  padding: 6px 8px 6px 12px;
  border-radius: 999px;
  background: #1e1e2e;
  color: #cdd6f4;
  font: ${TYPE.fontPx}px/${TYPE.lineHeight} -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 6px 18px rgba(17, 17, 27, 0.35), 0 0 0 1px rgba(205, 214, 244, 0.08);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}
.chip:hover { background: #181825; }
.text { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
/* The label is what gives way when the two lines do not both fit. */
.label { overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 11px; line-height: 1.2; color: #a6adc8; overflow: hidden; text-overflow: ellipsis; }
.sub[hidden] { display: none; }
.value { font-weight: 600; color: #f5e0dc; }
/* A better answer is still on its way, so the value on screen may yet change.
   The dot says that standing still: nothing on the chip loops. */
.pending {
  display: inline-block;
  flex: none;
  width: 7px;
  height: 7px;
  margin-left: -2px;
  border-radius: 50%;
  background: var(--carat-accent);
  opacity: 0.8;
}
.pending[hidden] { display: none; }
/* A replaced value arrives on the spot the old one held, so only the word changes. */
.value.is-fresh, .label.is-fresh { animation: carat-fade var(--carat-fresh-ms) ease-out; }
@keyframes carat-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* --- arrival --- */
/* A fade and a 2px rise. No spring, no overshoot, no ring off the edge. */
.chip.is-entering { animation: carat-enter var(--carat-enter-ms) ease-out both; }
/* The banner has no control to rise toward, so it fades where it stands. */
.chip.is-banner.is-entering { animation: carat-fade var(--carat-enter-ms) ease-out both; }
@keyframes carat-enter {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}

/* --- the press --- */
/* The keycap darkens under an accepted Tab and comes back. It does not move. */
kbd.is-press { background: #232334; color: #9399b2; }
.chip.is-armed kbd.is-press { background: #11111b; color: #d8c48d; }

/* --- leaving --- */
/* One exit for every way an offer can end: the pill fades where it stands. */
.chip.is-leaving { animation: carat-out var(--carat-exit-ms) ease-out forwards; }
@keyframes carat-out {
  to { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  /* All that is left to turn off are the fades. */
  .value.is-fresh, .label.is-fresh { animation: none; }
  .chip.is-entering, .chip.is-banner.is-entering, .chip.is-leaving { animation: none; }
}
/* Armed: the first Tab landed on something that cannot be undone, so the chip turns amber until the second. */
.chip.is-armed { background: var(--carat-amber); color: #1e1e2e; box-shadow: 0 6px 18px rgba(${RING.armedRgb}, 0.35), 0 0 0 1px rgba(30, 30, 46, 0.2); }
.chip.is-armed:hover { background: #f5d88a; }
.chip.is-armed .value { color: #1e1e2e; }
.chip.is-armed .sub { color: #4c4f69; }
.chip.is-armed kbd { background: #1e1e2e; color: var(--carat-amber); border-color: #1e1e2e; }
/* The tab offer has no field to sit beside, so it reads as a banner: larger type, wider, centred. */
.chip.is-banner {
  max-width: min(640px, calc(100vw - 32px));
  gap: 14px;
  padding: 12px 14px 12px 20px;
  border-radius: 16px;
  font-size: ${TYPE.bannerFontPx}px;
  box-shadow: 0 10px 30px rgba(17, 17, 27, 0.45), 0 0 0 1px rgba(205, 214, 244, 0.1);
}
.chip.is-banner .sub { font-size: 12px; }
.chip.is-banner .pending { width: 9px; height: 9px; margin-left: -6px; }
.chip.is-banner kbd {
  padding: ${KEYCAP.bannerPadYPx}px ${KEYCAP.bannerPadXPx}px;
  border-radius: ${KEYCAP.bannerRadiusPx}px;
  font-size: ${KEYCAP.bannerFontPx}px;
}
/* Sized off the label, not off itself: see KEYCAP above. */
kbd {
  all: initial;
  display: inline-block;
  padding: ${KEYCAP.padYPx}px ${KEYCAP.padXPx}px;
  border-radius: ${KEYCAP.radiusPx}px;
  background: #313244;
  color: #cdd6f4;
  border: ${KEYCAP.borderPx}px solid #45475a;
  font: 600 ${KEYCAP.fontPx}px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
`;

/**
 * The one mark carat leaves on a page's own control: a hairline accent
 * outline over its box, fading out over `flashMs`, when an offer has just
 * acted on it. It is carat's own overlay box, never a style on the page's
 * element, so nothing the page laid out can move.
 */
export const FX_CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483645;
  --carat-accent: ${RING.accentRgb};
  --carat-flash-ms: ${TIMING.flashMs}ms;
}
.fx {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
  border-radius: ${RING.radiusPx}px;
}
.fx.is-amber { --carat-accent: ${RING.armedRgb}; }
/* Accept: one hairline round the control, and then it is gone. */
.fx.flash {
  border: 1px solid rgba(var(--carat-accent), 0.9);
  animation: carat-fx-flash var(--carat-flash-ms) ease-out forwards;
}
.fx.flash.is-static { border-color: rgba(var(--carat-accent), 0.8); }
@keyframes carat-fx-flash {
  from { opacity: 1; }
  to { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .fx { animation: none !important; }
}
`;
