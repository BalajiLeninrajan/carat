import type { NextActionKind } from '@carat/shared';
import type { ContextStore } from '../store';
import { interactSuppressionKey } from '../store';
import type { PerformDiag } from './diag';

/** How a perform ended: whole, or with the pick that should have followed the typing left undone. */
export type PerformOutcome = 'done' | 'partial';

/**
 * What became of the one chip on a page. `accepted` with `outcome: 'partial'`
 * means the text went in but the list or calendar pick that should have
 * followed did not.
 */
export interface FeedbackInput {
  kind: NextActionKind;
  /** The control's accessible name, or the destination for open and switch. */
  name: string;
  /** What the chip said, for the timeline. */
  label: string;
  /** The actual value acted on, when the action has one. */
  value?: string;
  host: string;
  accepted: boolean;
  outcome?: PerformOutcome;
  /** The chip armed and the user pressed Tab a second time. */
  irreversible?: boolean;
}

export interface FeedbackSinks {
  /** A money control accepted, or a fill left half done: the popup and the later goal layer read these. */
  onPerform?: (tabId: number, entry: PerformDiag) => void;
  /** The per-tab timeline, so the next request knows what just happened here. */
  onHistory?: (tabId: number | undefined, line: string) => void;
  /** Optional durable action audit sink, currently Elasticsearch. */
  onElastic?: (tabId: number | undefined) => void;
}

/**
 * Esc suppresses that control for ten minutes; Tab is remembered in the
 * timeline instead, because what the user just did is the strongest signal
 * for what they will do next. Nothing is chained: the next chip comes from
 * the next snapshot.
 */
export async function handleFeedback(data: FeedbackInput, store: ContextStore, tabId?: number, sinks: FeedbackSinks = {}): Promise<void> {
  sinks.onElastic?.(tabId);
  // The timeline wraps this in "accepted suggestion:" or "dismissed suggestion:".
  const clause = `${verb(data.kind)}${data.name ? ` "${data.name}"` : ''}`;
  if (!data.accepted) {
    await store.markDismissed(interactSuppressionKey(data.host, data.kind, data.name));
    sinks.onHistory?.(tabId, clause);
    return;
  }
  sinks.onHistory?.(tabId, clause);
  if (tabId === undefined) return;
  if (data.irreversible) sinks.onPerform?.(tabId, { at: Date.now(), host: data.host, kind: 'money', name: data.name || data.label, outcome: 'done' });
  else if (data.outcome === 'partial') sinks.onPerform?.(tabId, { at: Date.now(), host: data.host, kind: 'fill', name: data.name, outcome: 'partial' });
}

function verb(kind: NextActionKind): string {
  switch (kind) {
    case 'fill':
      return 'fill';
    case 'click':
      return 'click';
    case 'select':
      return 'select in';
    case 'scroll':
      return 'scroll down';
    case 'open':
      return 'open';
    case 'switch':
      return 'switch to';
    case 'none':
      return 'nothing';
  }
}
