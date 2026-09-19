import type { ActionSuggestion, FillSuggestion, IntentName, PageMeta, RequestContext, SuggestRequest, Suggestion } from '@carat/shared';
import { isIntentDestination } from '@carat/shared';
import type { Provider } from './provider';
import { sameSite } from './same-site';
import { classifyField, type FieldKind } from './local/fields';
import { interactions } from './local/interact';
import { candidatesFrom, type Candidate } from './local/candidates';
import { extractAddress, extractEmailRequest, extractPlan, extractWhen } from './local/extract';

const CONFIDENCE = 0.75;
type Ctx = SuggestRequest['context'][number];

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
  const candidates = context.map((ctx) => ({ ctx, found: candidatesFrom(ctx) }));
  const out: FillSuggestion[] = [];
  const filledKinds = new Set<FieldKind>();
  for (const field of fields) {
    if (field.v) continue;
    const kind = classifyField(field);
    if (!kind || filledKinds.has(kind)) continue;
    let best: { hit: Hit; ctx: Ctx } | null = null;
    for (const { ctx, found } of candidates) {
      const hit = find(kind, found);
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

function find(kind: FieldKind, found: Candidate[]): Hit | null {
  const of = (k: Candidate['kind']) => found.find((c) => c.kind === k);
  switch (kind) {
    case 'email': {
      const c = of('email');
      return c ? { value: c.value, reason: 'email address found in recent text', score: SCORE.exact } : null;
    }
    case 'phone': {
      const c = of('phone');
      return c ? { value: c.value, reason: 'phone number found in recent text', score: SCORE.exact } : null;
    }
    case 'location': {
      const address = of('address');
      if (address) return { value: address.value, reason: 'street address found in recent text', score: SCORE.address };
      return placeHit(of('place'));
    }
    case 'title': {
      const plan = of('plan');
      if (plan) return { value: plan.value, reason: 'plan mentioned in recent text', score: SCORE.exact };
      const event = of('event');
      if (event) return { value: event.value, reason: 'event name found in recent text', score: SCORE.event };
      return placeHit(of('place'));
    }
    case 'search': {
      return placeHit(of('place'));
    }
  }
}

function placeHit(place: Candidate | undefined): Hit | null {
  if (!place) return null;
  return {
    value: place.value,
    reason: place.activity ? 'plan mentioned in recent text' : 'place name found in recent text',
    score: place.activity ? SCORE.exact : SCORE.titleCase,
  };
}
