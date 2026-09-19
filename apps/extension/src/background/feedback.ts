import type { ContextStore } from '../store';
import { navSuppressionKey, suppressionKey } from '../store';

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

export type FeedbackInput = FillFeedback | NavFeedback;

export async function handleFeedback(data: FeedbackInput, store: ContextStore): Promise<void> {
  const key =
    data.kind === 'nav'
      ? navSuppressionKey(data.intent, data.value)
      : suppressionKey(data.contextId, data.host, data.fingerprint);
  if (data.accepted) await store.markConsumed(key);
  else await store.markDismissed(key);
}
