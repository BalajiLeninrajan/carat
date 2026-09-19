import type { FillSuggestion, PageMeta, SuggestRequest } from '@carat/shared';
import { refusesFill } from '@carat/shared';
import { classifyField, type FieldKind } from './fields';
import { candidatesFrom, type Candidate } from './candidates';

export const CONFIDENCE = 0.75;
// A bare name with no cue around it: above the eager floor, under the balanced one.
export const LOOSE_CONFIDENCE = 0.45;

type Ctx = SuggestRequest['context'][number];

// score: how specific the match is; the best hit across all context items wins.
// A street address outranks a planned place for location fields (brief: an
// address belongs in a location field), whichever context item is listed first.
type Hit = { value: string; reason: string; score: number; confidence: number };
const SCORE = { address: 4, exact: 3, event: 2, titleCase: 1, name: 0.5 } as const;
/**
 * What the page the user is looking at is worth over another tab, for the
 * same kind of match: enough to win a tie, not enough to beat a stricter
 * kind. A street address from a Maps tab still beats a place name read here.
 */
const OWN_BONUS = 0.25;

export interface FillSources {
  /** The page being filled plus its selection, first, and other tabs' text after it. */
  sources: Ctx[];
  /** Which of those ids are the requesting tab's own. */
  ownIds: ReadonlySet<string>;
  page: Pick<PageMeta, 'title' | 'h1' | 'host'>;
}

/**
 * One fill per field kind from the regex candidates in `sources`, the page's
 * own text first. With `loose` (the eager level) bare capitalised names and
 * quoted strings also count for search and title fields. Nothing that reads
 * the field or the page back to itself gets through, whatever it scored.
 */
export function fills(fields: SuggestRequest['fields'], from: FillSources, loose: boolean): FillSuggestion[] {
  const { sources, ownIds, page } = from;
  if (sources.length === 0) return [];
  const candidates = sources.map((ctx) => ({ ctx, found: candidatesFrom(ctx, loose), own: ownIds.has(ctx.id) }));
  const out: FillSuggestion[] = [];
  const filledKinds = new Set<FieldKind>();
  for (const field of fields) {
    if (field.v) continue;
    const kind = classifyField(field);
    if (!kind || filledKinds.has(kind)) continue;
    let best: { hit: Hit; ctx: Ctx; score: number } | null = null;
    for (const { ctx, found, own } of candidates) {
      const hit = find(kind, found);
      if (!hit || refusesFill(hit.value, field, page, own)) continue;
      const score = hit.score + (own ? OWN_BONUS : 0);
      if (!best || score > best.score) best = { hit, ctx, score };
    }
    if (!best) continue;
    out.push({ kind: 'fill', fieldId: field.i, value: best.hit.value, confidence: best.hit.confidence, reason: best.hit.reason, sourceContextId: best.ctx.id });
    filledKinds.add(kind);
  }
  return out;
}

/** The page's own text first, then other tabs', with the ids that came from this page. */
export function fillSources(req: SuggestRequest, context: Ctx[]): FillSources {
  const own = req.own ?? [];
  return { sources: [...own, ...context], ownIds: new Set(own.map((c) => c.id)), page: req.page };
}

// The `name` candidate only exists at eager, so search and title fall through to it there and nowhere else.
function find(kind: FieldKind, found: Candidate[]): Hit | null {
  const of = (k: Candidate['kind']) => found.find((c) => c.kind === k);
  switch (kind) {
    case 'email': {
      const c = of('email');
      return c ? { value: c.value, reason: 'email address found in recent text', score: SCORE.exact, confidence: CONFIDENCE } : null;
    }
    case 'phone': {
      const c = of('phone');
      return c ? { value: c.value, reason: 'phone number found in recent text', score: SCORE.exact, confidence: CONFIDENCE } : null;
    }
    case 'location': {
      const address = of('address');
      if (address) return { value: address.value, reason: 'street address found in recent text', score: SCORE.address, confidence: CONFIDENCE };
      return placeHit(of('place'));
    }
    case 'title': {
      const plan = of('plan');
      if (plan) return { value: plan.value, reason: 'plan mentioned in recent text', score: SCORE.exact, confidence: CONFIDENCE };
      const event = of('event');
      if (event) return { value: event.value, reason: 'event name found in recent text', score: SCORE.event, confidence: CONFIDENCE };
      return placeHit(of('place')) ?? nameHit(of('name'));
    }
    case 'search': {
      return placeHit(of('place')) ?? nameHit(of('name'));
    }
  }
}

function placeHit(place: Candidate | undefined): Hit | null {
  if (!place) return null;
  return {
    value: place.value,
    reason: place.activity ? 'plan mentioned in recent text' : 'place name found in recent text',
    score: place.activity ? SCORE.exact : SCORE.titleCase,
    confidence: CONFIDENCE,
  };
}

function nameHit(name: Candidate | undefined): Hit | null {
  if (!name) return null;
  return { value: name.value, reason: 'capitalised name in recent text, no cue around it', score: SCORE.name, confidence: LOOSE_CONFIDENCE };
}
