import type { SuggestRequest, Suggestion } from '@carat/shared';
import type { Provider } from './provider';
import { sameSite } from './same-site';
import { classifyField, type FieldKind } from './local/fields';
import { extractAddress, extractEmail, extractEvent, extractPhone, extractPlace, type Place } from './local/extract';

const CONFIDENCE = 0.75;
type Ctx = SuggestRequest['context'][number];

const TITLE_ACTIVITIES = new Set(['dinner', 'lunch', 'brunch', 'breakfast', 'coffee', 'drinks', 'meeting', 'party', 'movie', 'game', 'practice']);

// score: how specific the match is; the best hit across all context items wins.
// A street address outranks a planned place for location fields (brief: an
// address belongs in a location field), whichever context item is listed first.
type Hit = { value: string; reason: string; score: number };
const SCORE = { address: 4, exact: 3, event: 2, titleCase: 1 } as const;

// Regex fallback: no network, fixed confidence, one field per kind.
export class LocalProvider implements Provider {
  readonly id = 'local' as const;

  async suggest(req: SuggestRequest, opts: { signal: AbortSignal }): Promise<Suggestion[]> {
    if (opts.signal.aborted) return [];
    const context = req.context.filter((c) => !sameSite(c.origin, req.page.host));
    if (context.length === 0) return [];

    const out: Suggestion[] = [];
    const filledKinds = new Set<FieldKind>();
    for (const field of req.fields) {
      if (field.v) continue;
      const kind = classifyField(field);
      if (!kind || filledKinds.has(kind)) continue;
      let best: { hit: Hit; ctx: Ctx } | null = null;
      for (const ctx of context) {
        const hit = find(kind, ctx.text);
        if (hit && (!best || hit.score > best.hit.score)) best = { hit, ctx };
      }
      if (!best) continue;
      out.push({ fieldId: field.i, value: best.hit.value, confidence: CONFIDENCE, reason: best.hit.reason, sourceContextId: best.ctx.id });
      filledKinds.add(kind);
    }
    return out;
  }
}

function find(kind: FieldKind, text: string): Hit | null {
  switch (kind) {
    case 'email': {
      const v = extractEmail(text);
      return v ? { value: v, reason: 'email address found in recent text', score: SCORE.exact } : null;
    }
    case 'phone': {
      const v = extractPhone(text);
      return v ? { value: v, reason: 'phone number found in recent text', score: SCORE.exact } : null;
    }
    case 'location': {
      const address = extractAddress(text);
      if (address) return { value: address, reason: 'street address found in recent text', score: SCORE.address };
      return placeHit(extractPlace(text));
    }
    case 'title': {
      const place = extractPlace(text);
      if (place?.activity && TITLE_ACTIVITIES.has(place.activity)) {
        const activity = place.activity[0]!.toUpperCase() + place.activity.slice(1);
        return { value: `${activity} at ${place.name}`, reason: 'plan mentioned in recent text', score: SCORE.exact };
      }
      const event = extractEvent(text);
      if (event) return { value: event, reason: 'event name found in recent text', score: SCORE.event };
      return placeHit(place);
    }
    case 'search': {
      return placeHit(extractPlace(text));
    }
  }
}

function placeHit(place: Place | null): Hit | null {
  if (!place) return null;
  return {
    value: place.name,
    reason: place.activity ? 'plan mentioned in recent text' : 'place name found in recent text',
    score: place.activity ? SCORE.exact : SCORE.titleCase,
  };
}
