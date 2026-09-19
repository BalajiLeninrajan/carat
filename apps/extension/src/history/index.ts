// stub: replaced by balaji/engine-evidence
//
// The content script's half of the timeline: what the user just did on this
// page, reported to the background as one line each ("clicked button
// \"Add to cart\""). The evidence branch writes it; this stub is the seam the
// content entrypoint already calls.
import type { ScriptContext } from '../content/context';

export interface HistoryHandle {
  stop(): void;
}

export function startHistoryLog(_ctx: ScriptContext, _doc: Document = document): HistoryHandle {
  return { stop: () => undefined };
}
