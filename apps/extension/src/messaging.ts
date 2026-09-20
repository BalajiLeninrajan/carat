import { defineExtensionMessaging } from '@webext-core/messaging';
import type { GetDataType, GetReturnType } from '@webext-core/messaging';
import type { ContextItem, NextAction, NextActionRequest, Settings } from '@carat/shared';
import type { DebugSnapshot } from './background/debug';
import type { CdpAction, CdpPerformReply, EvidenceReply } from './background/page-evidence';
import type { TabDiag } from './background/diag';
import type { HistoryEntry } from './history';
import type { NavigationResult } from './background/navigation';
import type { FeedbackInput } from './background/feedback';
import type { GhostInput, GhostReply } from './background/ghost';
import type { StatusInfo } from './background/status';
import type { VisionCue } from './background/vision';

export type KnownItem = Pick<ContextItem, 'id' | 'origin' | 'title' | 'kind' | 'capturedAt'> & {
  preview: string;
};

/**
 * What the content script knows: the page, its outline, the numbered controls
 * and which one has focus. The background adds the history, the notes, the
 * open tabs, the time and the eagerness level before the request reaches a
 * provider.
 */
export type PageSnapshot = Pick<NextActionRequest, 'page' | 'outline' | 'controls' | 'focused'> & {
  /** Which reader produced the outline: Chrome's accessibility tree, or the DOM walk. */
  evidence?: 'cdp' | 'dom';
  /** Why the DOM walk stood in, when it did. */
  evidenceReason?: string;
  /** The page has a visible password field: never read, never acted on. */
  password?: boolean;
  /** The user asked with the shortcut: past the cache and past what they dismissed. */
  force?: boolean;
};

export interface NextActionResponse {
  /** The action to show now, or null when there is nothing yet. */
  action: NextAction | null;
  /** Set when a better answer may still come; the content script polls `nextActionRefine` with it. */
  ticket?: string;
}

/**
 * A later word on the same request. `target` alone moves the ring before the
 * model has finished writing; `action` replaces what the chip shows. `more`
 * says the ticket is still open and the content script should poll again.
 * `lost` says the service worker restarted while this ticket was open, so the
 * answer is never coming and the page should ask again rather than settle.
 */
export interface ActionUpdate {
  target?: number;
  action?: NextAction | null;
  more?: boolean;
  lost?: boolean;
}

/** Tab or Esc on the chip, and how the action ended if it was performed. */
export interface PerformedAction {
  kind: NextAction['kind'];
  label: string;
  /** The control's accessible name, for the timeline line. */
  name?: string;
  host: string;
}

// Background handles every message but `forceSuggest`, `contextCleared`,
// `toggleDebug` and `debugEvent`, which it sends to one tab's content script
// when a keyboard shortcut fires, the stores are wiped, or the debug panel
// that tab has open has something new to show.
export interface Protocol {
  capture(data: { url: string; title: string; text: string; kind: 'page' | 'selection'; leaving?: boolean }): void;
  /** What the user just did on the page: clicks and typing, for the per-tab timeline. */
  history(data: { entries: HistoryEntry[] }): void;
  /**
   * Read this tab through the debugger's accessibility tree. The reply either
   * carries the outline, the numbered controls and a box per control, or says
   * why the page should build the outline itself this time.
   */
  cdpEvidence(data: { budget?: number }): EvidenceReply;
  /**
   * Point at a debugger-numbered control: the worker dispatches an event on
   * the node so this page's own listener can take the element and perform on
   * it with the page's fill and click paths.
   */
  cdpResolve(data: { n: number; token: string }): CdpPerformReply;
  /** Carry the action out through the debugger, for a control this page cannot reach. */
  cdpPerform(data: { n: number; action: CdpAction; value: string }): CdpPerformReply;
  /** One page in, one action out. */
  nextAction(data: PageSnapshot): NextActionResponse;
  /** Long-poll for the next word on a reply's `ticket`; polled again while the answer says `more`. */
  nextActionRefine(data: { ticket: string }): ActionUpdate;
  /**
   * The grey text after the caret. The first call on an `id` starts one
   * completion and answers with the first token; the calls after it carry
   * `have` and wait for more than that, until one comes back `more: false`.
   * An empty answer means the model had nothing to continue, which hands Tab
   * back to the action chip.
   */
  ghost(data: GhostInput): GhostReply;
  /** Screenshot cues from a tab; see VisionCue. */
  vision(data: VisionCue): void;
  forceSuggest(): void;
  /** The stores were just wiped; the tab drops its chip and everything it remembers about this page load. */
  contextCleared(): void;
  feedback(data: FeedbackInput): void;
  /** Sent only from a Tab press on an `open` or `switch` chip; the background rebuilds the URL from the registry. */
  navigate(data: { kind: 'open' | 'switch'; value: string }): NavigationResult;
  getKnown(): { items: KnownItem[]; pinned: boolean; goal?: string };
  /** The × beside the goal line in the popup: drop it, and let the next derivation find another. */
  clearGoal(): void;
  /** The popup's button. The keyboard shortcut runs the same routine in the background. */
  clearKnown(): void;
  setPinned(data: { pinned: boolean }): { pinned: boolean };
  getDiag(data: { tabId: number }): { diag: TabDiag | null };
  /**
   * Everything the background knows about one tab, for the debug panel. A
   * content script asks about its own tab and leaves `tabId` out; the popup
   * and the options page may name one.
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
  getSettings(): Settings;
  setSettings(s: Partial<Settings>): Settings;
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
