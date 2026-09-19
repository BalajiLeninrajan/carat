import type { Suggestion } from './types';

/**
 * Fold a slower, smarter answer into the one already shown. Per slot (a
 * field for fills, an element for interactions) the higher confidence wins
 * and a tie keeps what is there, so a chip can only ever change to something
 * the model was surer of. Actions in `incoming` are ignored: a tab offer is
 * built from the page's own text, which the smart model reads no better, and
 * a late one would move the corner chip under the user. Sorted best first.
 */
export function mergeSuggestions(current: Suggestion[], incoming: Suggestion[]): Suggestion[] {
  const best = new Map<string, Suggestion>();
  const offer = (s: Suggestion): void => {
    const key = slotOf(s);
    const prev = best.get(key);
    if (!prev || s.confidence > prev.confidence) best.set(key, s);
  };
  for (const s of current) offer(s);
  for (const s of incoming) if (s.kind !== 'action') offer(s);
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

function slotOf(s: Suggestion): string {
  switch (s.kind) {
    case 'fill':
      return `f|${s.fieldId}`;
    case 'interact':
      return `e|${s.elementId}`;
    case 'action':
      return `a|${s.intent}|${s.value}`;
  }
}
