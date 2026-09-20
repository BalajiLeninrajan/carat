import { clearActionCache } from './orchestrate';

/** The ids the manifest gives the two keyboard shortcuts. */
export const COMMANDS = {
  suggest: 'carat-suggest',
  clear: 'clearContext',
} as const;

/**
 * Everything a clear wipes, as the little each store has to offer. Written as
 * structural types so a test can hand in a counter and the worker can hand in
 * the real stores.
 */
export interface Clearable {
  /** The context store: every page and selection read, what was accepted or dismissed, and the pin. */
  store: { clear(): Promise<void> };
  /** Screenshots waiting to be read. */
  shots: { clear(): Promise<void> };
  /** The per-tab timeline. */
  history: { clear(): Promise<void> };
  /** The distilled notes from other tabs. */
  notes: { clear(): Promise<void> };
  /** The one line for what the user is trying to get done across tabs. */
  goal?: { clear(): Promise<void> };
  /** The 60 s answer cache; defaults to the orchestrator's own. */
  cache?: () => void;
}

/**
 * What "clear" means, in one place: the popup's button and Alt+Shift+X both
 * end here. Settings stay — the key, the provider, the model, the eagerness,
 * the per-site switches, the screenshot and status-line choices.
 */
export async function clearAll(what: Clearable): Promise<void> {
  // Synchronous and first: no answer should survive the stores it was built from.
  (what.cache ?? clearActionCache)();
  await Promise.all([
    what.store.clear(),
    what.shots.clear(),
    what.history.clear(),
    what.notes.clear(),
    what.goal?.clear() ?? Promise.resolve(),
  ]);
}

/** What the clear shortcut needs from the worker. */
export interface ClearCommandDeps {
  clear(): Promise<void>;
  /** Tell one tab's content script the context is gone. A tab with no content script rejects; that is fine. */
  notify(tabId: number): void;
}

/**
 * `Alt+Shift+X` from any page. The wipe runs first and the tab is told after,
 * so the chip goes away with the context it was built from. A command that is
 * not this one, or a key pressed over a tab Chrome cannot name, does nothing.
 */
export function handleClearCommand(command: string, tabId: number | undefined, deps: ClearCommandDeps): void {
  if (command !== COMMANDS.clear || tabId === undefined) return;
  void deps.clear().then(
    () => deps.notify(tabId),
    () => undefined,
  );
}
