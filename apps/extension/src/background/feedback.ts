import type { ContextStore } from '../store';
import { suppressionKey } from '../store';

export interface FeedbackInput {
  fieldId: string;
  fingerprint: string;
  contextId: string;
  accepted: boolean;
  host: string;
}

export async function handleFeedback(data: FeedbackInput, store: ContextStore): Promise<void> {
  const key = suppressionKey(data.contextId, data.host, data.fingerprint);
  if (data.accepted) await store.markConsumed(key);
  else await store.markDismissed(key);
}
