import { defineExtensionMessaging } from '@webext-core/messaging';
import type { GetDataType, GetReturnType } from '@webext-core/messaging';
import type { ContextItem, FieldDescriptor, PageMeta, Settings, Suggestion } from '@carat/shared';

export type KnownItem = Pick<ContextItem, 'id' | 'origin' | 'title' | 'kind' | 'capturedAt'> & {
  preview: string;
};

/** Where a suggestion came from, as much as a content script may know: the host and when it was read. */
export interface SuggestionSource {
  host: string;
  capturedAt: number;
}

export type SuggestionView = Suggestion & { source?: SuggestionSource };

// Background handles every message; content scripts and extension pages only send.
export interface Protocol {
  capture(data: { url: string; title: string; text: string; kind: 'page' | 'selection' }): void;
  suggestRequest(data: { page: PageMeta; fields: FieldDescriptor[] }): { suggestions: SuggestionView[] };
  feedback(data: {
    fieldId: string;
    fingerprint: string;
    contextId: string;
    accepted: boolean;
    host: string;
  }): void;
  getKnown(): { items: KnownItem[] };
  clearKnown(): void;
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
