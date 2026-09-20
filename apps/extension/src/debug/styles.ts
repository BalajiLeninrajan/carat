// The chip's palette, darker: this is a reading surface, not an offer. Inline
// so no page CSS can reach it, and nothing here is animated.
export const DEBUG_CSS = `
:host { all: initial; }
.panel {
  all: initial;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border-radius: 10px;
  overflow: hidden;
  background: #181825;
  color: #cdd6f4;
  font: 11px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 10px 30px rgba(17, 17, 27, 0.55), 0 0 0 1px rgba(205, 214, 244, 0.1);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 6px 8px;
  background: #1e1e2e;
  border-bottom: 1px solid rgba(205, 214, 244, 0.08);
  cursor: move;
  user-select: none;
  -webkit-user-select: none;
}
.title { color: #cdd6f4; font-weight: 600; }
.where { color: #6c7086; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button {
  all: initial;
  font: inherit;
  color: #a6adc8;
  background: #313244;
  border-radius: 5px;
  padding: 2px 7px;
  cursor: pointer;
}
button:hover { color: #cdd6f4; background: #45475a; }
button:focus-visible { outline: 2px solid #89b4fa; outline-offset: 1px; }
.body { flex: 1; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 10px; }
section { display: flex; flex-direction: column; gap: 4px; }
h2 {
  all: initial;
  font: 600 10px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #89b4fa;
}
.rows { display: grid; grid-template-columns: max-content 1fr; gap: 1px 10px; }
.k { color: #6c7086; }
.v, pre, .log { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
.v { color: #cdd6f4; overflow-wrap: anywhere; }
.v.is-bad { color: #f38ba8; }
pre {
  all: initial;
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 10.5px;
  line-height: 1.5;
  color: #bac2de;
  background: #11111b;
  border-radius: 6px;
  padding: 6px 8px;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
mark {
  background: rgba(137, 180, 250, 0.2);
  color: #89b4fa;
  border-radius: 3px;
  padding: 0 2px;
}
.log { display: flex; flex-direction: column; gap: 1px; max-height: 180px; overflow: auto; font-size: 10.5px; }
.line { display: flex; gap: 8px; }
.at { color: #6c7086; flex: none; width: 58px; text-align: right; }
.src { color: #9399b2; flex: none; width: 46px; }
.what { color: #bac2de; overflow-wrap: anywhere; }
.empty { color: #6c7086; font-style: italic; }
.grip {
  position: absolute;
  top: 0;
  left: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
}
`;
