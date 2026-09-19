// stub: replaced by balaji/engine-evidence
//
// Reading memory: a page the user has left, distilled into a few facts they
// may act on somewhere else. The distiller is injected, so the engine's
// provider does the model call and this module only decides what is worth
// distilling and how long a note lives.
export interface NoteInput {
  text: string;
  host: string;
  title: string;
  url: string;
}

export interface Notes {
  /** Distill a page the user just left. Never throws; notes are a bonus, not a step. */
  record(input: NoteInput, signal: AbortSignal): Promise<void>;
  /** The notes for a request on `host`, newest first, at most eight; notes from that same page are left out. */
  lines(host: string): Promise<string[]>;
}

export type Distill = (text: string, host: string, signal: AbortSignal) => Promise<string[]>;

export interface NotesDeps {
  distill: Distill;
  now?: () => number;
}

const TTL_MS = 60 * 60_000;
const MAX_NOTES = 20;
const PROMPT_NOTES = 8;

export function createNotes(deps: NotesDeps): Notes {
  const now = deps.now ?? (() => Date.now());
  let kept: Array<{ at: number; host: string; url: string; text: string }> = [];
  const lastSeen = new Map<string, string>();

  return {
    async record(input, signal) {
      const text = input.text.trim();
      if (text.length < 40 || lastSeen.get(input.url) === text) return;
      lastSeen.set(input.url, text);
      let facts: string[] = [];
      try {
        facts = await deps.distill(text, input.host, signal);
      } catch {
        return;
      }
      const at = now();
      kept = [...kept.filter((n) => n.url !== input.url), ...facts.map((t) => ({ at, host: input.host, url: input.url, text: t }))].slice(-MAX_NOTES);
    },
    async lines(host) {
      const cutoff = now() - TTL_MS;
      return kept
        .filter((n) => n.at > cutoff && n.host !== host)
        .slice(-PROMPT_NOTES)
        .reverse()
        .map((n) => `${n.text} (read on ${n.host})`);
    },
  };
}
