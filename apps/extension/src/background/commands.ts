/** The two keyboard shortcuts, by the ids the manifest gives them. */
export const COMMANDS = {
  suggest: 'carat-suggest',
  clear: 'clearContext',
} as const;

/** What a command needs from the worker: one tab's content script, and the clear routine. */
export interface CommandDeps {
  /** Wipe the session store. */
  clear(): Promise<void>;
  /** Tell one tab's content script. A tab with no content script (chrome://, the store) rejects; that is fine. */
  notify(tabId: number, message: 'forceSuggest' | 'contextCleared'): void;
}

/**
 * Both shortcuts, handled the same way: do the work, then tell the focused
 * tab. Clearing tells it after the store is empty, so the chip goes away with
 * the context it was built from.
 */
export function handleCommand(command: string, tabId: number | undefined, deps: CommandDeps): void {
  if (tabId === undefined) return;
  if (command === COMMANDS.suggest) {
    deps.notify(tabId, 'forceSuggest');
    return;
  }
  if (command === COMMANDS.clear) {
    void deps.clear().then(
      () => deps.notify(tabId, 'contextCleared'),
      () => undefined,
    );
  }
}
