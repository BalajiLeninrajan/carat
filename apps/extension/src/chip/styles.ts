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
.label { overflow: hidden; text-overflow: ellipsis; }
.value { font-weight: 600; color: #f5e0dc; }
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
