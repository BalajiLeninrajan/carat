import type { ContextStore } from '../store';
import { interactSuppressionKey, navSuppressionKey, suppressionKey } from '../store';
import type { PerformDiag } from './diag';

/** How a perform ended: whole, or with the pick that should have followed the typing left undone. */
export type PerformOutcome = 'done' | 'partial';

export interface FillFeedback {
  kind?: 'fill';
  fieldId: string;
  fingerprint: string;
  contextId: string;
  accepted: boolean;
  host: string;
  /** Present only when the fill stopped short: the text is in, the list or calendar pick did not happen. */
  outcome?: PerformOutcome;
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
  /** The control moves money and was accepted with Enter. */
  money?: true;
}

export type FeedbackInput = FillFeedback | NavFeedback | InteractFeedback;

export interface FeedbackSinks {
  /** Every accepted money control and every partial fill is logged per tab; the popup and the later goal layer read it. */
  onPerform?: (tabId: number, entry: PerformDiag) => void;
}

/**
 * `tabId` is the sender's tab. An accepted fill is also remembered there for
 * a minute, which is what lets a provider offer the Save button next. An
 * accepted interaction is not remembered here at all: the content script
 * keeps it out for the rest of that page load, and the next page load may
 * well want the same Save button again. Esc on one suppresses it for 10 minutes.
 * A partial fill counts as a fill (the text went in) but is not consumed, so
 * the same value may be offered again once the field is empty again.
 */
export async function handleFeedback(data: FeedbackInput, store: ContextStore, tabId?: number, sinks: FeedbackSinks = {}): Promise<void> {
  if (data.kind === 'interact') {
    if (!data.accepted) await store.markDismissed(interactSuppressionKey(data.host, data.role, data.name));
    else if (data.money && tabId !== undefined) sinks.onPerform?.(tabId, { at: Date.now(), host: data.host, kind: 'money', name: data.name, outcome: 'done' });
    return;
  }
  if (data.kind !== 'nav' && data.accepted && data.outcome === 'partial') {
    if (tabId !== undefined) {
      sinks.onPerform?.(tabId, { at: Date.now(), host: data.host, kind: 'fill', name: data.fieldId, outcome: 'partial' });
      await store.markFilled(tabId, data.contextId);
    }
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
