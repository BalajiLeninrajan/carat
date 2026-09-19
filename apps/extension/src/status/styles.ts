// Same palette and reset as the chip; inline so no page CSS can reach it.
export const STATUS_CSS = `
:host { all: initial; pointer-events: none; }
.line {
  all: initial;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px 5px 8px;
  border-radius: 999px;
  background: rgba(30, 30, 46, 0.92);
  color: #a6adc8;
  font: 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 4px 14px rgba(17, 17, 27, 0.3), 0 0 0 1px rgba(205, 214, 244, 0.08);
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6c7086;
  flex: none;
}
.is-running .dot { background: #a6e3a1; }
.is-running { color: #cdd6f4; }
.is-busy .dot { animation: carat-pulse 1s ease-in-out infinite; }
@keyframes carat-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.75); }
}
@media (prefers-reduced-motion: reduce) { .is-busy .dot { animation: none; opacity: 0.6; } }
`;
