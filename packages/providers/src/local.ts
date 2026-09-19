import type { ActionSuggestion, FillSuggestion, IntentName, PageMeta, RequestContext, SuggestRequest, Suggestion } from '@carat/shared';
import { isIntentDestination } from '@carat/shared';
import type { Provider } from './provider';
import { sameSite } from './same-site';
import { classifyField, type FieldKind } from './local/fields';
import { interactions } from './local/interact';
import {
  extractAddress,
  extractEmail,
  extractEmailRequest,
  extractEvent,
  extractPhone,
  extractPlace,
  extractPlan,
  extractWhen,
  type Place,
} from './local/extract';

const CONFIDENCE = 0.75;
type Ctx = SuggestRequest['context'][number];

const TITLE_ACTIVITIES = new Set(['dinner', 'lunch', 'brunch', 'breakfast', 'coffee', 'drinks', 'meeting', 'party', 'movie', 'game', 'practice']);

// score: how specific the match is; the best hit across all context items wins.
// A street address outranks a planned place for location fields (brief: an
// address belongs in a location field), whichever context item is listed first.
type Hit = { value: string; reason: string; score: number };
const SCORE = { address: 4, exact: 3, event: 2, titleCase: 1 } as const;

// Regex fallback: no network, fixed confidence, one field per kind, one action per intent, narrow interactions.
export class LocalProvider implements Provider {
  readonly id = 'local' as const;

  async suggest(req: SuggestRequest, opts: { signal: AbortSignal }): Promise<Suggestion[]> {
    if (opts.signal.aborted) return [];
    const context = req.context.filter((c) => !sameSite(c.origin, req.page.host));
    return [
      ...fills(req.fields, context),
      ...interactions(req.elements ?? [], context, req.filled ?? []),
      ...actions(req.own ?? [], req.page, req.now),
    ];
  }
}

function fills(fields: SuggestRequest['fields'], context: Ctx[]): FillSuggestion[] {
  if (context.length === 0) return [];
  const out: FillSuggestion[] = [];
  const filledKinds = new Set<FieldKind>();
  for (const field of fields) {
    if (field.v) continue;
    const kind = classifyField(field);
    if (!kind || filledKinds.has(kind)) continue;
    let best: { hit: Hit; ctx: Ctx } | null = null;
    for (const ctx of context) {
      const hit = find(kind, ctx.text);
      if (hit && (!best || hit.score > best.hit.score)) best = { hit, ctx };
    }
    if (!best) continue;
    out.push({ kind: 'fill', fieldId: field.i, value: best.hit.value, confidence: CONFIDENCE, reason: best.hit.reason, sourceContextId: best.ctx.id });
    filledKinds.add(kind);
  }
  return out;
}

/**
 * Actions come only from the page being read: a planned "<activity> at <Place>"
 * opens Maps, the same plan with a time goes to Calendar, an email address to
 * Gmail. A destination the user is already on is never offered.
 */
function actions(own: RequestContext, page: PageMeta, now: string): ActionSuggestion[] {
  const here = `https://${page.host}${page.path}`;
  const out = new Map<IntentName, ActionSuggestion>();
  const offer = (a: ActionSuggestion): void => {
    if (!out.has(a.intent) && !isIntentDestination(a.intent, here)) out.set(a.intent, a);
  };
  for (const ctx of own) {
    const plan = extractPlan(ctx.text);
    if (plan) {
      offer(action('maps', plan.name, ctx.id, 'plan names a place to look up'));
      const when = extractWhen(ctx.text.slice(plan.end, plan.end + 80), now, plan.activity);
      if (when) {
        const activity = plan.activity[0]!.toUpperCase() + plan.activity.slice(1);
        offer({
          ...action('calendar', `${activity} at ${plan.name}`, ctx.id, 'plan has a place and a time'),
          when,
          location: extractAddress(ctx.text) ?? plan.name,
        });
      }
    }
    const email = extractEmailRequest(ctx.text);
    if (email) offer(action('gmail', email, ctx.id, 'the text asks the reader to email this address'));
  }
  return [...out.values()];
}

function action(intent: IntentName, value: string, sourceContextId: string, reason: string): ActionSuggestion {
  return { kind: 'action', intent, value, when: '', location: '', confidence: CONFIDENCE, reason, sourceContextId };
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
