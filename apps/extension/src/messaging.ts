import { defineExtensionMessaging } from '@webext-core/messaging';
import type { GetDataType, GetReturnType } from '@webext-core/messaging';
import type {
  ContextItem,
  ElementDescriptor,
  FieldDescriptor,
  FillSuggestion,
  InteractSuggestion,
  NavSuggestion,
  PageMeta,
  PageState,
  Settings,
} from '@carat/shared';
import type { TabDiag } from './background/diag';
import type { HistoryEntry } from './history';
import type { FeedbackInput } from './background/feedback';
import type { StatusInfo } from './background/status';
import type { VisionCue } from './background/vision';

export type KnownItem = Pick<ContextItem, 'id' | 'origin' | 'title' | 'kind' | 'capturedAt'> & {
  preview: string;
};

/** Where a suggestion came from, as much as a content script may know: the host and when it was read. */
export interface SuggestionSource {
  host: string;
  capturedAt: number;
}

export type SuggestionView = FillSuggestion & { source?: SuggestionSource };
export type NavigationView = NavSuggestion & { source?: SuggestionSource };
export type InteractionView = InteractSuggestion & { source?: SuggestionSource };

export interface SuggestResponse {
  suggestions: SuggestionView[];
  navigation: NavigationView[];
  /** Resolved against `elements` in the request; the content script performs one after a Tab. */
  interactions: InteractionView[];
  /** Set when a better answer may still come (the chat model, the smart model); the content script polls `suggestRefine` with it. */
  ticket?: string;
}

/**
 * A later answer: fills and interactions folded over what the chip already
 * shows. Tab offers are never refined. `more` says the ticket is still open
 * and the content script should poll again for the next one.
 */
export type RefineResponse = Pick<SuggestResponse, 'suggestions' | 'interactions'> & { more?: boolean };

// Background handles every message but `forceSuggest`, which it sends to one
// tab's content script when the keyboard shortcut fires. Content scripts and
// extension pages otherwise only send.
export interface Protocol {
  capture(data: { url: string; title: string; text: string; kind: 'page' | 'selection'; leaving?: boolean }): void;
  /** What the user just did on the page: clicks and typing, for the per-tab timeline. */
  history(data: { entries: HistoryEntry[] }): void;
  /** `force` skips the answer cache and the dismissed/consumed filter: the user asked out loud. */
  suggestRequest(data: { page: PageMeta; fields: FieldDescriptor[]; elements?: ElementDescriptor[]; state?: PageState; force?: boolean }): SuggestResponse;
  /** Long-poll for the next answer on a fast reply's `ticket`; polled again while the answer says `more`. */
  suggestRefine(data: { ticket: string }): RefineResponse;
  /** Screenshot cues from a tab; see VisionCue. */
  vision(data: VisionCue): void;
  forceSuggest(): void;
  feedback(data: FeedbackInput): void;
  /** Sent only from a navigation chip's Tab press; the background rebuilds the URL before acting. */
  navigate(data: NavSuggestion): { ok: boolean };
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
