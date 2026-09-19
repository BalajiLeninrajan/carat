import { describe, expect, it, vi } from 'vitest';
import type { NextActionRequest } from '@carat/shared';
import { JevProvider, decide } from '../src/jev';
import { NEXT_QUESTION, NONE, SCROLL, buildJevRequest } from '../src/jev/request';

const req: NextActionRequest = {
  page: { host: 'shop.example', title: 'Your cart', path: '/cart', scroll: { y: 0, pages: 1.2, more: true } },
  outline: '[1] searchbox "Search"\n[2] button "Proceed to checkout"\n[3] button "Pay $34.00"',
  controls: [
    { n: 1, role: 'searchbox', name: 'Search' },
    { n: 2, role: 'button', name: 'Proceed to checkout' },
    { n: 3, role: 'button', name: 'Pay $34.00', risky: true },
  ],
  history: ['12s ago: clicked button "Add to cart"'],
  notes: ['Dinner at Seven Shores Cafe on Friday at 6.'],
  tabs: [],
  now: '2026-09-16T14:04:00-04:00',
  eagerness: 'eager',
  allowPayments: false,
};

const answers = (choice: string, p: number) => ({
  [NEXT_QUESTION]: { type: 'choice', choice, confidence: p, probabilities: { [choice]: p } },
});

describe('the Jev question', () => {
  it('asks one choice question over the controls, a scroll and nothing', () => {
    const built = buildJevRequest(req)!;
    const choices = (built.questions[NEXT_QUESTION]!.criteria as { choices: Record<string, string> }).choices;
    expect(Object.keys(choices).sort()).toEqual(['c1', 'c2', NONE, SCROLL].sort());
    expect(built.state.notes).toEqual(req.notes);
    expect(built.state.history).toEqual(req.history);
  });

  it('leaves a risky control out of the options entirely', () => {
    expect(buildJevRequest(req)!.options.some((o) => o.control.n === 3)).toBe(false);
  });

  it('only offers a text control when a regex candidate can fill it', () => {
    const noNotes = buildJevRequest({ ...req, notes: [] })!;
    expect(noNotes.options.map((o) => o.key)).toEqual(['c2']);
  });

  it('turns a chosen control into a click at Jev’s own probability', () => {
    const built = buildJevRequest(req)!;
    expect(decide(built, answers('c2', 0.72), req)).toMatchObject({ kind: 'click', target: 2, confidence: 0.72 });
  });

  it('turns a chosen text control into a fill with the candidate', () => {
    const built = buildJevRequest(req)!;
    expect(decide(built, answers('c1', 0.6), req)).toMatchObject({ kind: 'fill', target: 1, value: 'Seven Shores Cafe' });
  });

  it('drops a pick under the level’s floor, and answers nothing on none', () => {
    const built = buildJevRequest(req)!;
    expect(decide(built, answers('c2', 0.2), req)).toBeNull();
    expect(decide(built, answers(NONE, 0.9), req)).toBeNull();
  });

  it('only scrolls while there is more page below', () => {
    const built = buildJevRequest(req)!;
    expect(decide(built, answers(SCROLL, 0.6), req)).toMatchObject({ kind: 'scroll', target: null });
    const atTheEnd = { ...req, page: { ...req.page, scroll: { y: 1, pages: 1, more: false } } };
    expect(decide(built, answers(SCROLL, 0.6), atTheEnd)).toBeNull();
  });

  it('answers nothing on a Cloudflare error envelope and rejects on a transport failure', async () => {
    const envelope = vi.fn(
      async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'bad token' }] }), { status: 403 }),
    ) as unknown as typeof fetch;
    const provider = new JevProvider({ accountId: 'a', apiToken: 't' }, envelope);
    expect(await provider.next(req, { signal: new AbortController().signal })).toBeNull();

    const boom = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(new JevProvider({ accountId: 'a', apiToken: 't' }, boom).next(req, { signal: new AbortController().signal })).rejects.toThrow('offline');
  });
});
