import type { GetDataType, GetReturnType } from '@webext-core/messaging';
import { defineExtensionMessaging } from '@webext-core/messaging';
import type { DebugSnapshot } from './debug/log';
import type { ActionAnalytics } from './background/elastic';
import type { Settings } from './engine/shared/settings';
import type { StatusInfo } from './status/info';

/**
 * One-shot messages, for the surfaces that are not the decision loop: the
 * popup, the options page, the debug panel and the three keyboard shortcuts.
 * The loop itself runs over the engine's long-lived port, one per tab, and
 * never touches this.
 *
 * The background handles every message but `forceSuggest`, `contextCleared`,
 * `toggleDebug` and `debugEvent`, which it sends to one tab's content script.
 *
 * Messages that name a `tabId` come from the popup, which has no tab of its
 * own to be the sender.
 */
export interface Protocol {
  /** Alt+Shift+C: ask on this page now, past the idle wait. */
  forceSuggest(): void;
  /** Alt+Shift+X, or the popup's button: what carat remembered is gone, so drop the chip too. */
  contextCleared(): void;
  /** The popup's button and Alt+Shift+X both end here. Settings stay. */
  clearKnown(): void;
  /**
   * Everything the background knows about one tab, for the debug panel. A
   * content script asks about its own tab and leaves `tabId` out; the popup
   * may name one.
   */
  getDebug(data: { tabId?: number }): DebugSnapshot;
  /** The panel opened or closed on this tab. Nothing extra is kept until it has opened once. */
  setDebug(data: { on: boolean }): { on: boolean };
  /** Background to one tab: the panel's data moved. */
  debugEvent(data: DebugSnapshot): void;
  /** Alt+Shift+D on this tab: the panel opens, or closes if it was open. */
  toggleDebug(): void;
  /** What the status line on a page may show: running or not, and the model in use. Never the key. */
  getStatus(): StatusInfo;
  /** Recent suggestion outcomes and trends for the popup analytics tab. */
  getAnalytics(): ActionAnalytics;
  /** Did the user press Cancel on Chrome's debugging bar over this tab? The popup asks about the tab it opened over. */
  isTabPaused(data: { tabId: number }): boolean;
  /** The popup's Resume button: unpause that tab and ask it for a suggestion straight away. */
  resumeTab(data: { tabId: number }): void;
  getSettings(): Settings;
  setSettings(s: Partial<Settings>): Settings;
  /**
   * Background to the offscreen document: paste and hand back what came out.
   * A service worker has no DOM, so this is the only way to read the clipboard.
   */
  readClipboard(): { text: string };
}

export const { sendMessage, onMessage } = defineExtensionMessaging<Protocol>();

/**
 * Content-script send that survives the extension being reloaded under a
 * still-open tab: "Extension context invalidated" is swallowed and reported
 * as `undefined` instead of an unhandled rejection.
 */
export async function safeSendMessage<K extends keyof Protocol>(
  type: K,
  data: GetDataType<Protocol[K]>,
): Promise<GetReturnType<Protocol[K]> | undefined> {
  try {
    return await sendMessage(type, data);
  } catch (err) {
    if (isContextInvalidated(err)) return undefined;
    throw err;
  }
}

function isContextInvalidated(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /extension context invalidated|receiving end does not exist|message port closed/i.test(msg);
}
