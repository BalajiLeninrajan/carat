/**
 * Every duration, easing and accent the chip animates with is a custom
 * property on the shadow root, so the whole feel is tuned in one block rather
 * than hunted through keyframes. The JS reads the same numbers from `TIMING`
 * below; keep the two in step.
 */
export const TIMING = {
  /** The spring a new chip arrives on. */
  enterMs: 180,
  /** The one-time glow ring that expands off a first offer. */
  glowMs: 600,
  /** The accent outline a field chip draws round its control on arrival. */
  outlineMs: 900,
  /** The keycap's "that value just changed" bounce. */
  bumpMs: 80,
  /** The keycap held down under an accepted Tab. */
  pressMs: 90,
  /** The chip collapsing toward the control it just acted on. */
  collapseMs: 160,
  /** The scroll banner sweeping up with the page. */
  sweepMs: 280,
  /** The open/switch banner shrinking toward the tab strip. */
  shrinkMs: 240,
  /** Esc, and anything else the user says no with. */
  dismissMs: 120,
  /** The satisfaction flash on the control, and the tint under a filled field. */
  flashMs: 450,
  /** The ripple out of a clicked control's centre. */
  rippleMs: 350,
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
export const KEYFRAME_CLASSES = ['is-entering', 'has-glow', 'is-leaving'] as const;

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
  --carat-accent: #89b4fa;
  --carat-amber: #f9e2af;
  --carat-enter-ms: ${TIMING.enterMs}ms;
  --carat-enter-ease: cubic-bezier(0.34, 1.4, 0.64, 1);
  --carat-glow-ms: ${TIMING.glowMs}ms;
  --carat-bump-ms: ${TIMING.bumpMs}ms;
  --carat-press-ms: ${TIMING.pressMs}ms;
  --carat-collapse-ms: ${TIMING.collapseMs}ms;
  --carat-sweep-ms: ${TIMING.sweepMs}ms;
  --carat-shrink-ms: ${TIMING.shrinkMs}ms;
  --carat-dismiss-ms: ${TIMING.dismissMs}ms;
  /* Set from the target's side of the pill, so a collapse falls toward it. */
  --carat-origin: 50% 50%;
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
  transform-origin: var(--carat-origin);
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
.value.is-fresh, .label.is-fresh { animation: carat-fade 180ms ease-out; }
@keyframes carat-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* --- arrival --- */
.chip.is-entering { animation: carat-enter var(--carat-enter-ms) var(--carat-enter-ease) both; }
.chip.is-banner.is-entering { animation: carat-rise var(--carat-enter-ms) ease-out both; }
@keyframes carat-enter {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes carat-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
/* One soft ring off a first offer, so the eye finds it. Never on a retry. */
.glow {
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  border: 2px solid var(--carat-accent);
  box-shadow: 0 0 12px 2px rgba(137, 180, 250, 0.4);
  pointer-events: none;
  animation: carat-glow var(--carat-glow-ms) ease-out forwards;
}
@keyframes carat-glow {
  from { opacity: 0.6; transform: scale(1); }
  to { opacity: 0; transform: scale(1.3); }
}
/* --- the press --- */
kbd.is-press { transform: translateY(1px); background: #232334; color: #9399b2; }
.chip.is-armed kbd.is-press { background: #11111b; color: #d8c48d; }
kbd.is-bump { animation: carat-bump var(--carat-bump-ms) ease-out; }
@keyframes carat-bump {
  50% { transform: translateY(-2px) scale(1.06); }
}

/* --- leaving --- */
.chip.is-leaving.exit-collapse { animation: carat-collapse var(--carat-collapse-ms) ease-in forwards; }
.chip.is-leaving.exit-sweep { animation: carat-sweep var(--carat-sweep-ms) ease-in forwards; }
.chip.is-leaving.exit-shrink { animation: carat-shrink var(--carat-shrink-ms) ease-in forwards; }
.chip.is-leaving.exit-soft { animation: carat-soft var(--carat-dismiss-ms) ease-out forwards; }
@keyframes carat-collapse {
  to { opacity: 0; transform: scale(0.62); }
}
@keyframes carat-sweep {
  to { opacity: 0; transform: translateY(-40px); }
}
@keyframes carat-shrink {
  to { opacity: 0; transform: translateY(-28px) scale(0.5); }
}
@keyframes carat-soft {
  to { opacity: 0; transform: translateY(4px); }
}

@media (prefers-reduced-motion: reduce) {
  .value.is-fresh, .label.is-fresh { animation: none; }
  .chip.is-entering, .chip.is-banner.is-entering, kbd.is-bump { animation: none; }
  .chip.is-leaving.exit-collapse, .chip.is-leaving.exit-sweep, .chip.is-leaving.exit-shrink, .chip.is-leaving.exit-soft { animation: none; }
  .glow { display: none; }
  kbd.is-press { transform: none; }
}
/* Armed: the first Tab landed on something that cannot be undone, so the chip turns amber until the second. */
.chip.is-armed { background: var(--carat-amber); color: #1e1e2e; box-shadow: 0 6px 18px rgba(249, 226, 175, 0.35), 0 0 0 1px rgba(30, 30, 46, 0.2); }
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
 * The marks carat leaves on the page's own controls: an outline, a bloom, a
 * tint, a ripple. All of them are carat's own overlay boxes over the
 * control's rect, never a style on the page's element, so nothing the page
 * laid out can move.
 */
export const FX_CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483645;
  --carat-accent: 137, 180, 250;
  --carat-outline-ms: ${TIMING.outlineMs}ms;
  --carat-flash-ms: ${TIMING.flashMs}ms;
  --carat-ripple-ms: ${TIMING.rippleMs}ms;
}
.fx {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
  border-radius: 7px;
}
.fx.is-amber { --carat-accent: 249, 226, 175; }
/* Arrival: a hairline round the control the chip is about. */
.fx.outline {
  border: 1.5px solid rgba(var(--carat-accent), 0.9);
  animation: carat-fx-outline var(--carat-outline-ms) ease-out forwards;
}
.fx.outline.is-static { border-color: rgba(var(--carat-accent), 0.75); }
@keyframes carat-fx-outline {
  0% { opacity: 0; }
  15% { opacity: 1; }
  100% { opacity: 0; }
}
/* Accept: the outline blooms from 2px to 6px and goes. */
.fx.flash {
  border: 1px solid rgba(var(--carat-accent), 0.9);
  animation: carat-fx-flash var(--carat-flash-ms) ease-out forwards;
}
.fx.flash.is-static { border-color: rgba(var(--carat-accent), 0.8); }
@keyframes carat-fx-flash {
  from { opacity: 1; box-shadow: 0 0 0 2px rgba(var(--carat-accent), 0.55); }
  to { opacity: 0; box-shadow: 0 0 0 6px rgba(var(--carat-accent), 0); }
}
/* A fill gets a moment of accent under the words that just landed. */
.fx.tint {
  background: rgba(var(--carat-accent), 0.08);
  animation: carat-fx-tint var(--carat-flash-ms) ease-out forwards;
}
.fx.tint.is-static { opacity: 1; }
@keyframes carat-fx-tint {
  from { opacity: 1; }
  to { opacity: 0; }
}
/* A click gets a ripple out of the control's centre. */
.fx.ripple {
  border-radius: 50%;
  background: rgba(var(--carat-accent), 0.35);
  animation: carat-fx-ripple var(--carat-ripple-ms) ease-out forwards;
}
@keyframes carat-fx-ripple {
  from { opacity: 0.55; transform: scale(0.2); }
  to { opacity: 0; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .fx { animation: none !important; }
  .fx.ripple { display: none; }
}
`;
