import { describe, expect, it } from 'vitest';
import type { ElementDescriptor, FieldDescriptor, PageState, SuggestRequest, Suggestion } from '@carat/shared';
import { EAGERNESS, EAGERNESS_LEVELS } from '@carat/shared';
import { PRIOR_CONFIDENCE, nextStep } from '../src/next-step';

const NOW = '2026-09-16T14:10:00-04:00';
const discord = { id: 'c1', origin: 'https://discord.com', title: 'Discord', kind: 'page' as const, text: 'alex: dinner at Seven Shores Cafe, Friday at 6? email me at alex@example.com', capturedAt: 1 };

function serp(over: Partial<PageState> = {}, elements?: ElementDescriptor[]): SuggestRequest {
  return {
    page: { host: 'www.google.com', title: 'doordash - Google Search', path: '/search' },
    state: { kind: 'serp', q: 'doordash', y: 0, pages: 3, more: true, ...over },
    fields: [],
    elements: elements ?? [
      { i: 'e0', r: 'button', nm: 'Tools' },
      { i: 'e1', r: 'link', nm: 'DoorDash - Wikipedia', v: 'en.wikipedia.org' },
      { i: 'e2', r: 'link', nm: 'DoorDash Food Delivery & Takeout', v: 'www.doordash.com' },
      { i: 'e3', r: 'link', nm: 'Best delivery apps 2026', v: 'www.cnet.com', o: 1 },
    ],
    context: [],
    now: NOW,
  };
}

function article(over: Partial<PageState> = {}): SuggestRequest {
  return {
    page: { host: 'www.cbc.ca', title: 'Fare increase', path: '/news/fare' },
    state: { kind: 'article', y: 0.3, pages: 5, more: true, ...over },
    fields: [{ i: 'f0', t: 'input:search', al: 'Search CBC' }],
    context: [],
    now: NOW,
  };
}

function checkout(fields: FieldDescriptor[], elements?: ElementDescriptor[], kind: 'checkout' | 'form' = 'checkout'): SuggestRequest {
  return {
    page: { host: 'shop.example.com', title: 'Checkout', path: '/checkout' },
    state: { kind, y: 0, pages: 1.5, more: true },
    fields,
    elements: elements ?? [
      { i: 'e0', r: 'button', nm: 'Apply' },
      { i: 'e1', r: 'button', nm: 'Continue to payment', p: 1 },
      { i: 'e2', r: 'link', nm: 'Return to cart', v: 'shop.example.com' },
    ],
    context: [discord],
    now: NOW,
  };
}

const ids = (out: Suggestion[]) => out.map((s) => (s.kind === 'fill' ? `fill:${s.fieldId}` : s.kind === 'interact' ? `${s.verb}:${s.elementId || 'page'}` : `action:${s.intent}`));

describe('nextStep on a results page', () => {
  it('picks the result whose host matches the query over an earlier one whose title merely mentions it', () => {
    const step = nextStep(serp(), 'eager');
    expect(ids(step.suggestions)).toEqual(['click:e2']);
    expect(step.suggestions[0]).toMatchObject({ confidence: PRIOR_CONFIDENCE.serpMatch, sourceContextId: 'page', value: 'DoorDash Food Delivery & Takeout' });
    expect(step.note).toBe("serp: first result matches query 'doordash'");
    expect(step.best).toBe(PRIOR_CONFIDENCE.serpMatch);
  });

  it('falls back to a title match, then to the first result at a lower confidence', () => {
    const titled = serp({ q: 'doordash wikipedia' });
    expect(ids(nextStep(titled, 'eager').suggestions)).toEqual(['click:e1']);
    const unrelated = serp({ q: 'best pizza' });
    const step = nextStep(unrelated, 'eager');
    expect(step.suggestions[0]).toMatchObject({ elementId: 'e1', confidence: PRIOR_CONFIDENCE.serpFirst });
    expect(step.note).toBe('serp: first result');
    // Under the balanced prior floor: nothing shows, and the note says so.
    const balanced = nextStep(unrelated, 'balanced');
    expect(balanced.suggestions).toEqual([]);
    expect(balanced.note).toContain('under the balanced prior floor (0.6)');
  });

  it('skips a result already clicked on this page load, and offers a scroll instead once past the first screen', () => {
    expect(ids(nextStep(serp({ done: ['link|doordash food delivery & takeout'] }), 'eager').suggestions)).toEqual(['click:e1']);
    const scrolled = nextStep(serp({ y: 1.4 }, [{ i: 'e3', r: 'link', nm: 'Best delivery apps 2026', v: 'www.cnet.com', o: 1 }]), 'eager');
    expect(ids(scrolled.suggestions)).toEqual(['scroll:page']);
    expect(scrolled.note).toBe('serp: past the first screen, scroll');
    // An on-screen match still wins past the first screen.
    expect(ids(nextStep(serp({ y: 1.4 }), 'eager').suggestions)).toEqual(['click:e2']);
  });

  it('never names a link without a state, and nothing at conservative', () => {
    const { state: _s, ...bare } = serp();
    expect(nextStep(bare, 'eager')).toMatchObject({ kind: undefined, suggestions: [], best: 0 });
    expect(nextStep(serp(), 'conservative').suggestions).toEqual([]);
    expect(nextStep(serp(), 'conservative').candidates.length).toBe(1);
  });
});

describe('nextStep on an article or feed', () => {
  it('yields one page scroll at eager, none below, and none when there is nothing below the fold', () => {
    const eager = nextStep(article(), 'eager');
    expect(eager.suggestions).toEqual([
      { kind: 'interact', elementId: '', verb: 'scroll', value: '', confidence: PRIOR_CONFIDENCE.scroll, reason: expect.any(String), sourceContextId: 'page' },
    ]);
    expect(eager.note).toBe('article: scroll');
    expect(nextStep(article(), 'balanced').suggestions).toEqual([]);
    expect(nextStep(article({ more: false }), 'eager')).toMatchObject({ suggestions: [], note: 'article: at the end' });
    expect(nextStep({ ...article(), state: { ...article().state!, kind: 'feed' } }, 'eager').note).toBe('feed: scroll');
  });

  it('does not repeat a scroll until new content appears', () => {
    const again = nextStep(article({ done: ['scroll'] }), 'eager');
    expect(again.suggestions).toEqual([]);
    expect(again.note).toBe('article: scrolled, nothing new below');
  });

  it('yields to a fill or click the caller already has, unless that one is weak for the level', () => {
    const strong: Suggestion = { kind: 'fill', fieldId: 'f0', value: 'Seven Shores Cafe', confidence: 0.75, reason: '', sourceContextId: 'c1' };
    expect(nextStep(article(), 'eager', [strong]).suggestions).toEqual([]);
    const weak = { ...strong, confidence: 0.45 };
    expect(ids(nextStep(article(), 'eager', [weak]).suggestions)).toEqual(['scroll:page']);
    // Jev still sees the scroll as a candidate either way.
    expect(nextStep(article(), 'eager', [strong]).candidates.map((c) => c.note)).toEqual(['scroll']);
  });
});

describe('nextStep on a form or checkout', () => {
  const email: FieldDescriptor = { i: 'f0', t: 'input:email', lb: 'Email', rq: 1 };
  const name: FieldDescriptor = { i: 'f1', t: 'input:text', lb: 'Full name', rq: 1 };
  const discount: FieldDescriptor = { i: 'f2', t: 'input:text', lb: 'Discount code (optional)' };

  it('fills the first empty required field a context value fits, before any Continue', () => {
    const step = nextStep(checkout([name, email]), 'balanced');
    expect(step.suggestions).toEqual([expect.objectContaining({ kind: 'fill', fieldId: 'f0', value: 'alex@example.com', sourceContextId: 'c1' })]);
    expect(step.note).toBe('checkout: fill "Email" from context');
    // A context fill is not a page prior: it shows at conservative too, and does not count toward `best`.
    expect(nextStep(checkout([email]), 'conservative').suggestions.length).toBe(1);
    expect(step.best).toBe(0);
  });

  it('offers nothing for a field it has no value for, and says which one', () => {
    const step = nextStep(checkout([name]), 'eager');
    expect(step.suggestions).toEqual([]);
    expect(step.note).toBe("checkout: no value for 'Full name'");
  });

  it('offers Continue only once no empty field remains, optional fields aside', () => {
    const done = nextStep(checkout([discount]), 'balanced');
    expect(done.suggestions).toEqual([expect.objectContaining({ kind: 'interact', elementId: 'e1', verb: 'click', value: 'Continue to payment', confidence: PRIOR_CONFIDENCE.checkoutContinue, sourceContextId: 'page' })]);
    expect(done.note).toBe('checkout: Continue ("Continue to payment")');
    expect(nextStep(checkout([]), 'conservative').suggestions).toEqual([]);
    // A plain form's Continue is worth less: it clears eager only.
    const form = nextStep(checkout([], undefined, 'form'), 'balanced');
    expect(form.suggestions).toEqual([]);
    expect(nextStep(checkout([], undefined, 'form'), 'eager').suggestions[0]).toMatchObject({ confidence: PRIOR_CONFIDENCE.formContinue });
  });

  it('never picks a button that commits money or a message, even as the primary action', () => {
    const risky: ElementDescriptor[] = [
      { i: 'e0', r: 'button', nm: 'Place order', p: 1 },
      { i: 'e1', r: 'button', nm: 'Submit', p: 1 },
    ];
    const step = nextStep(checkout([], risky), 'eager');
    expect(step.suggestions).toEqual([]);
    expect(step.note).toBe('checkout: fields filled, no Continue button');
  });
});

describe('nextStep elsewhere', () => {
  it('adds nothing on a search app or an unknown page, and says so', () => {
    const maps: SuggestRequest = { ...article(), page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' }, state: { kind: 'search-app', y: 0, pages: 1, more: false } };
    expect(nextStep(maps, 'eager')).toMatchObject({ suggestions: [], note: 'search-app: nothing read to fill from' });
    expect(nextStep({ ...maps, context: [discord] }, 'eager').note).toBe('search-app: fill from context');
    expect(nextStep({ ...maps, state: { kind: 'unknown', y: 0, pages: 4, more: true } }, 'eager')).toMatchObject({ suggestions: [], note: 'unknown: no prior' });
  });

  it('keeps every prior at or over its level floor and drops the rest, at every level', () => {
    for (const level of EAGERNESS_LEVELS) {
      const floor = EAGERNESS[level].priorMin;
      for (const req of [serp(), article(), checkout([])]) {
        for (const s of nextStep(req, level).suggestions) if (s.sourceContextId === 'page') expect(s.confidence, `${req.state!.kind} at ${level}`).toBeGreaterThanOrEqual(floor);
      }
    }
  });
});
