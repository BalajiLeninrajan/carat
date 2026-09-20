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
  /** The keycap darkening under an accepted tap. */
  pressMs: 60,
  /** A replaced value cross-fading in place. */
  freshMs: 120,
  /** The chip fading out, whichever way the offer went. */
  exitMs: 100,
  /** The accent outline left on the control the offer acted on. */
  flashMs: 200,
} as const;

/**
 * The pill's own box, taken from the prototype's hint chip so the offer and
 * the ring read as one family: a 6px radius rather than a capsule, and the
 * hint's padding, mirrored because our keycap sits on the right where its
 * kbd sat on the left. The ring keeps its own slightly rounder 7px.
 */
export const PILL = {
  radiusPx: 6,
  padYPx: 5,
  /** The side the text is on. */
  padTextPx: 8,
  /** The side the keycap is on, which needs less. */
  padKeyPx: 5,
  gapPx: 6,
} as const;

/**
 * The pill's text, and the keycap sized off it. The keycap's outer box is
 * exactly the label's line box: same font size, and whatever padding is left
 * once its border is taken off. A key that stands taller than the words next
 * to it makes the pill look like a toolbar.
 */
export const TYPE = {
  fontPx: 12,
  lineHeight: 1.25,
} as const;

/** One line of pill text, in pixels. Everything on the pill is this tall. */
export const LINE_PX = TYPE.fontPx * TYPE.lineHeight;

export const KEYCAP = {
  fontPx: TYPE.fontPx,
  /** A fixed box the height of one text line, with the glyph centred in it. */
  heightPx: LINE_PX,
  borderPx: 1,
  padXPx: 5,
  radiusPx: 4,
} as const;

/**
 * The keycap, as declarations rather than a whole rule, so the chip's pill
 * and the hint at the end of ghost text draw the same key to the pixel.
 */
export const KEYCAP_CSS = `
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Centre the ink, not the em box. A cap and an arrow are both drawn from the
     baseline up, so the descender space the font reserves below them would
     ride the glyphs high in the box. Trimming to cap and baseline takes that
     space off, and what is left to centre is exactly what is drawn. */
  text-box-trim: trim-both;
  text-box-edge: cap alphabetic;
  box-sizing: border-box;
  height: ${KEYCAP.heightPx}px;
  padding: 0 ${KEYCAP.padXPx}px;
  border-radius: ${KEYCAP.radiusPx}px;
  background: #313244;
  color: #cdd6f4;
  border: ${KEYCAP.borderPx}px solid #45475a;
  font: 600 ${KEYCAP.fontPx}px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
`;

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
  --carat-alarm: ${RING.alarm};
  --carat-enter-ms: ${TIMING.enterMs}ms;
  --carat-fresh-ms: ${TIMING.freshMs}ms;
  --carat-exit-ms: ${TIMING.exitMs}ms;
}
.chip {
  all: initial;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: ${PILL.gapPx}px;
  /* Narrow viewports get the same pill, just less of the label: the second
     line is an instruction and has to stay whole. */
  max-width: min(360px, calc(100vw - 24px));
  padding: ${PILL.padYPx}px ${PILL.padKeyPx}px ${PILL.padYPx}px ${PILL.padTextPx}px;
  border-radius: ${PILL.radiusPx}px;
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
.text { display: flex; flex-direction: column; justify-content: center; min-width: 0; gap: 1px; }
/* The label is what gives way when the two lines do not both fit. */
.label { line-height: ${LINE_PX}px; text-box-trim: trim-both; text-box-edge: cap alphabetic; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 11px; line-height: 1.2; color: #a6adc8; overflow: hidden; text-overflow: ellipsis; }
.sub[hidden] { display: none; }
.value { font-weight: 600; color: #f5e0dc; }
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
/* The keycap darkens under an accepted tap and comes back. It does not move. */
kbd.is-press { background: #232334; color: #9399b2; }

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
/* Armed: the first tap landed on something that cannot be undone. The pill
   keeps its own colour and says so in words; the red ring round the control
   is what carries the warning, and one warning is enough. */
/* The tab offer has no field to sit beside, so it sits centred at the bottom. Same pill otherwise. */
.chip.is-banner {
  max-width: min(480px, calc(100vw - 32px));
  box-shadow: 0 6px 20px rgba(17, 17, 27, 0.4), 0 0 0 1px rgba(205, 214, 244, 0.1);
}
/* One text line tall, glyph centred: see KEYCAP above. */
kbd {
  all: initial;${KEYCAP_CSS}}
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
.fx.is-alarm { --carat-accent: ${RING.alarmRgb}; }
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
