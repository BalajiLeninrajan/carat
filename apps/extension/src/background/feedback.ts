import type { ContextStore } from '../store';
import { interactSuppressionKey, navSuppressionKey, suppressionKey } from '../store';

export interface FillFeedback {
  kind?: 'fill';
  fieldId: string;
  fingerprint: string;
  contextId: string;
  accepted: boolean;
  host: string;
}

export interface NavFeedback {
  kind: 'nav';
  intent: string;
  value: string;
  accepted: boolean;
}

export interface InteractFeedback {
  kind: 'interact';
  host: string;
  role: string;
  name: string;
  accepted: boolean;
}

export type FeedbackInput = FillFeedback | NavFeedback | InteractFeedback;

/**
 * `tabId` is the sender's tab. An accepted fill is also remembered there for
 * a minute, which is what lets a provider offer the Save button next. An
 * accepted interaction is not remembered here at all: the content script
 * keeps it out for the rest of that page load, and the next page load may
 * well want the same Save button again. Esc on one suppresses it for 10 minutes.
 */
export async function handleFeedback(data: FeedbackInput, store: ContextStore, tabId?: number): Promise<void> {
  if (data.kind === 'interact') {
    if (!data.accepted) await store.markDismissed(interactSuppressionKey(data.host, data.role, data.name));
    return;
  }
  const key =
    data.kind === 'nav'
      ? navSuppressionKey(data.intent, data.value)
      : suppressionKey(data.contextId, data.host, data.fingerprint);
  if (!data.accepted) {
    await store.markDismissed(key);
    return;
  }
  await store.markConsumed(key);
  if (data.kind !== 'nav' && tabId !== undefined) await store.markFilled(tabId, data.contextId);
}
