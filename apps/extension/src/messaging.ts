import { defineExtensionMessaging } from '@webext-core/messaging';
import type { GetDataType, GetReturnType } from '@webext-core/messaging';
import type { ContextItem, NextAction, NextActionRequest, Settings } from '@carat/shared';
import type { TabDiag } from './background/diag';
import type { FeedbackInput } from './background/feedback';
import type { StatusInfo } from './background/status';
import type { VisionCue } from './background/vision';

export type KnownItem = Pick<ContextItem, 'id' | 'origin' | 'title' | 'kind' | 'capturedAt'> & {
  preview: string;
};

/**
 * What the content script knows: the page, its outline, the numbered controls
 * and which one has focus. The background adds the history, the notes, the
 * open tabs, the time, the eagerness level and the payments setting before
 * the request reaches a provider.
 */
export type PageSnapshot = Pick<NextActionRequest, 'page' | 'outline' | 'controls' | 'focused'> & {
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
 */
export interface ActionUpdate {
  target?: number;
  action?: NextAction | null;
  more?: boolean;
}

/** Tab or Esc on the chip, and how the action ended if it was performed. */
export interface PerformedAction {
  kind: NextAction['kind'];
  label: string;
  /** The control's accessible name, for the timeline line. */
  name?: string;
  host: string;
}

// Background handles every message but `forceSuggest`, which it sends to one
// tab's content script when the keyboard shortcut fires.
export interface Protocol {
  capture(data: { url: string; title: string; text: string; kind: 'page' | 'selection' }): void;
  /** One page in, one action out. */
  nextAction(data: PageSnapshot): NextActionResponse;
  /** Long-poll for the next word on a reply's `ticket`; polled again while the answer says `more`. */
  nextActionRefine(data: { ticket: string }): ActionUpdate;
  /** Screenshot cues from a tab; see VisionCue. */
  vision(data: VisionCue): void;
  forceSuggest(): void;
  feedback(data: FeedbackInput): void;
  /** Sent only from a Tab press on an `open` or `switch` chip; the background rebuilds the URL from the registry. */
  navigate(data: { kind: 'open' | 'switch'; value: string }): { ok: boolean };
  getKnown(): { items: KnownItem[]; pinned: boolean };
  clearKnown(): void;
  setPinned(data: { pinned: boolean }): { pinned: boolean };
  getDiag(data: { tabId: number }): { diag: TabDiag | null };
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
