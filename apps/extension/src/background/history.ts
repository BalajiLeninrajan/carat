// stub: replaced by balaji/engine-evidence
//
// The per-tab timeline the prompt's <history> block is built from: what the
// user did, oldest first, at most a dozen lines. The engine only ever writes
// to it (an accepted or dismissed chip) and reads the lines for a request.
export interface HistoryLog {
  /** One line, already phrased the way the prompt shows it: `clicked button "Save"`. */
  record(tabId: number | undefined, line: string): Promise<void>;
  /** The lines for a request in this tab, oldest first, each prefixed with its age. */
  lines(tabId: number | undefined): Promise<string[]>;
}

export function createHistoryLog(): HistoryLog {
  const byTab = new Map<number, Array<{ at: number; line: string }>>();
  const MAX = 12;
  return {
    async record(tabId, line) {
      if (tabId === undefined) return;
      const list = byTab.get(tabId) ?? [];
      list.push({ at: Date.now(), line });
      byTab.set(tabId, list.slice(-MAX));
    },
    async lines(tabId) {
      if (tabId === undefined) return [];
      const now = Date.now();
      return (byTab.get(tabId) ?? []).map((e) => `${ago(now - e.at)}: ${e.line}`);
    },
  };
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}
