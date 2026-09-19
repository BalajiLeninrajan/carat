import type { ContextKind, SuggestRequest } from '@carat/shared';
import { extractAddress, extractEmail, extractEvent, extractName, extractPhone, extractPlace } from './extract';

export type CandidateKind = 'email' | 'phone' | 'address' | 'place' | 'plan' | 'event' | 'name';

/** A value the regexes found in one context item. Nothing here is invented; every value is a substring or a fixed composition of one. */
export interface Candidate {
  kind: CandidateKind;
  value: string;
  sourceContextId: string;
  /** For `place`: the activity noun that introduced it ("dinner at X"). */
  activity?: string;
}

export const CANDIDATE_LABEL: Record<CandidateKind, string> = {
  email: 'email address',
  phone: 'phone number',
  address: 'street address',
  place: 'place name',
  plan: 'plan (activity at a place)',
  event: 'event name',
  name: 'capitalised name (no cue around it)',
};

// Activities that read naturally as a calendar title ("Dinner at X"); "see you at X" does not.
const TITLE_ACTIVITIES = new Set(['dinner', 'lunch', 'brunch', 'breakfast', 'coffee', 'drinks', 'meeting', 'party', 'movie', 'game', 'practice']);

type Ctx = SuggestRequest['context'][number];
type Source = Pick<Ctx, 'id' | 'text'> & { kind?: ContextKind };

/**
 * First match of each kind in one context item, in a fixed order. With
 * `loose` (the eager level) a lowercase quoted string counts as a place and
 * the most recent bare capitalised name is added last, so it only ever wins
 * when nothing with a cue around it did.
 */
export function candidatesFrom(ctx: Source, loose = false): Candidate[] {
  const out: Candidate[] = [];
  const push = (kind: CandidateKind, value: string | null | undefined, extra: Partial<Candidate> = {}) => {
    if (value) out.push({ kind, value, sourceContextId: ctx.id, ...extra });
  };
  push('email', extractEmail(ctx.text));
  push('phone', extractPhone(ctx.text));
  push('address', extractAddress(ctx.text));
  const place = extractPlace(ctx.text, loose);
  if (place) {
    push('place', place.name, place.activity ? { activity: place.activity } : {});
    if (place.activity && TITLE_ACTIVITIES.has(place.activity)) {
      const activity = place.activity[0]!.toUpperCase() + place.activity.slice(1);
      push('plan', `${activity} at ${place.name}`);
    }
  }
  push('event', extractEvent(ctx.text));
  if (loose) {
    const name = extractName(ctx.text, ctx.kind ?? 'page');
    if (name && !out.some((c) => c.value === name)) push('name', name);
  }
  return out;
}

/** Candidates across all context items, in context order, with exact (kind, value) repeats dropped after their first source. */
export function extractCandidates(context: ReadonlyArray<Source>, loose = false): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const ctx of context) {
    for (const c of candidatesFrom(ctx, loose)) {
      const key = `${c.kind}\u0000${c.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
