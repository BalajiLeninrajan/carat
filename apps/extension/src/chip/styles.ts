// Inline so the chip needs no web-accessible resources and no page CSS can reach it.
export const CHIP_CSS = `
:host {
  all: initial;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483647;
  pointer-events: auto;
}
.chip {
  all: initial;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 360px;
  padding: 6px 8px 6px 12px;
  border-radius: 999px;
  background: #1e1e2e;
  color: #cdd6f4;
  font: 13px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 6px 18px rgba(17, 17, 27, 0.35), 0 0 0 1px rgba(205, 214, 244, 0.08);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}
.chip:hover { background: #181825; }
.text { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.label { overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 11px; line-height: 1.2; color: #a6adc8; overflow: hidden; text-overflow: ellipsis; }
.sub[hidden] { display: none; }
.value { font-weight: 600; color: #f5e0dc; }
/* A better answer is still on its way, so the value on screen may yet change. */
.pending {
  display: inline-block;
  flex: none;
  width: 7px;
  height: 7px;
  margin-left: -2px;
  border-radius: 50%;
  background: #89b4fa;
  animation: carat-pulse 1.1s ease-in-out infinite;
}
.pending[hidden] { display: none; }
/* The dot still says "waiting" without moving, for anyone who asked for less motion. */
.pending.is-static { animation: none; opacity: 0.8; }
@keyframes carat-pulse {
  0%, 100% { opacity: 0.25; transform: scale(0.75); }
  50% { opacity: 1; transform: scale(1); }
}
/* A replaced value arrives on the spot the old one held, so only the word changes. */
.value.is-fresh { animation: carat-fade 180ms ease-out; }
@keyframes carat-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .pending { animation: none; opacity: 0.8; }
  .value.is-fresh { animation: none; }
}
/* A control that moves money: a different colour, an Enter keycap, and Tab passes it by. */
.chip.is-money { background: #f9e2af; color: #1e1e2e; box-shadow: 0 6px 18px rgba(249, 226, 175, 0.35), 0 0 0 1px rgba(30, 30, 46, 0.2); }
.chip.is-money:hover { background: #f5d88a; }
.chip.is-money .value { color: #1e1e2e; }
.chip.is-money .sub { color: #4c4f69; }
.chip.is-money kbd { background: #1e1e2e; color: #f9e2af; border-color: #1e1e2e; }
/* The tab offer has no field to sit beside, so it reads as a banner: larger type, wider, centred. */
.chip.is-banner {
  max-width: min(640px, calc(100vw - 32px));
  gap: 14px;
  padding: 12px 14px 12px 20px;
  border-radius: 16px;
  font-size: 16px;
  box-shadow: 0 10px 30px rgba(17, 17, 27, 0.45), 0 0 0 1px rgba(205, 214, 244, 0.1);
}
.chip.is-banner .sub { font-size: 12px; }
.chip.is-banner .pending { width: 9px; height: 9px; margin-left: -6px; }
.chip.is-banner kbd { padding: 5px 10px; font-size: 13px; }
kbd {
  all: initial;
  display: inline-block;
  padding: 3px 7px;
  border-radius: 6px;
  background: #313244;
  color: #cdd6f4;
  border: 1px solid #45475a;
  border-bottom-width: 2px;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
`;
