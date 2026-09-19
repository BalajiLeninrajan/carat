import type { ActionSuggestion, Eagerness, IntentName, PageMeta, RequestContext, SuggestRequest, Suggestion } from '@carat/shared';
import { DEFAULT_EAGERNESS, EAGERNESS, isIntentDestination, mergeSuggestions } from '@carat/shared';
import type { Provider, SuggestOptions } from './provider';
import { sameSite } from './same-site';
import { CONFIDENCE, fillSources, fills } from './local/fills';
import { interactions, linkForQuery } from './local/interact';
import { extractAddress, extractEmailRequest, extractPlan, extractWhen } from './local/extract';
import { nextStep } from './next-step';

/**
 * Regex fallback: no network, one field per kind, one action per intent,
 * narrow interactions, the search result the page's own query names, and the
 * next-step priors for the page kind. At
 * `eager` it also offers bare capitalised names and lowercase quoted strings
 * for search and title fields, at a confidence that says so, and reads other
 * tabs on the page's own site.
 */
export class LocalProvider implements Provider {
  readonly id = 'local' as const;

  constructor(readonly eagerness: Eagerness = DEFAULT_EAGERNESS) {}

  async suggest(req: SuggestRequest, opts: SuggestOptions): Promise<Suggestion[]> {
    if (opts.signal.aborted) return [];
    const knobs = EAGERNESS[this.eagerness];
    const context = knobs.sameOriginContext ? req.context : req.context.filter((c) => !sameSite(c.origin, req.page.host));
    const known: Suggestion[] = [
      ...fills(req.fields, fillSources(req, context), knobs.looseNames),
      ...interactions(req.elements ?? [], [...(req.own ?? []), ...context], {
        filled: req.filled ?? [],
        gate: { eagerness: this.eagerness, flow: req.flow === true, fillable: req.fields.some((f) => !f.v) },
      }),
      ...linkForQuery(req.state, req.fields, req.elements ?? []),
    ];
    const step = nextStep(req, this.eagerness, known);
    // The page's priors fill the slots context left empty; per slot the surer one stays.
    return [...mergeSuggestions(known, step.suggestions), ...actions(req.own ?? [], req.page, req.now)];
  }
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
