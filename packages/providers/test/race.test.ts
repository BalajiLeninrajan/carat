import { describe, expect, it } from 'vitest';
import type { NextAction, NextActionRequest, Settings } from '@carat/shared';
import type { NextOptions, Provider } from '../src/provider';
import { RaceProvider } from '../src/race';

const req: NextActionRequest = {
  page: { host: 'example.test', title: 'Example', path: '/', scroll: { y: 0, pages: 1, more: false } },
  outline: '[1] button "Go"',
  controls: [{ n: 1, role: 'button', name: 'Go' }],
  history: [],
  notes: [],
  tabs: [],
  now: '2026-09-16T14:04:00-04:00',
  eagerness: 'eager',
};

const action = (over: Partial<NextAction> = {}): NextAction => ({
  kind: 'click',
  target: 1,
  value: '',
  label: 'Click "Go"',
  irreversible: false,
  confidence: 0.6,
  reason: '',
  ...over,
});

class Fake implements Provider {
  constructor(
    readonly id: Settings['provider'],
    private readonly answer: NextAction | null | Error,
    private readonly delayMs = 0,
  ) {}

  async next(_req: NextActionRequest, opts: NextOptions): Promise<NextAction | null> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (opts.signal.aborted) return null;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

describe('the race', () => {
  it('hands back the placeholder first and the model behind it', async () => {
    const placeholder = action({ kind: 'fill', value: 'Seven Shores Cafe', confidence: 0.5 });
    const model = action({ confidence: 0.8, label: 'Click "Order online"' });
    const race = new RaceProvider([new Fake('local', placeholder), new Fake('openai', model, 5)], { id: 'openai' });
    const first = await race.first(req, { signal: new AbortController().signal });
    expect(first).toBe(placeholder);
    const later: NextAction[] = [];
    for await (const answer of race.rest()) later.push(answer.action);
    expect(later).toEqual([model]);
    expect(race.attempts.map((a) => a.id)).toEqual(['local', 'openai']);
  });

  it('treats "none" as no answer, so the model still gets to speak first', async () => {
    const model = action({ confidence: 0.7 });
    const nothing = action({ kind: 'none', target: null, confidence: 0 });
    const race = new RaceProvider([new Fake('local', nothing), new Fake('openai', model, 5)], { id: 'openai' });
    expect(await race.first(req, { signal: new AbortController().signal })).toBe(model);
    const later: NextAction[] = [];
    for await (const answer of race.rest()) later.push(answer.action);
    expect(later).toEqual([]);
  });

  it('records a provider that throws and carries on', async () => {
    const model = action();
    const errors: string[] = [];
    const race = new RaceProvider([new Fake('local', new Error('offline')), new Fake('openai', model, 2)], {
      id: 'openai',
      onError: (id) => errors.push(id),
    });
    expect(await race.first(req, { signal: new AbortController().signal })).toBe(model);
    expect(errors).toEqual(['local']);
    expect(race.attempts.find((a) => a.id === 'local')?.error).toBe('offline');
  });

  it('answers nothing when the signal fires first', async () => {
    const race = new RaceProvider([new Fake('local', action(), 50)], { id: 'openai' });
    const controller = new AbortController();
    const pending = race.first(req, { signal: controller.signal });
    controller.abort();
    expect(await pending).toBeNull();
  });

  it('next() returns the surest answer once everything has settled', async () => {
    const race = new RaceProvider(
      [new Fake('local', action({ confidence: 0.5, label: 'placeholder' })), new Fake('openai', action({ confidence: 0.9, label: 'model' }), 2)],
      { id: 'openai' },
    );
    const settled = await race.next(req, { signal: new AbortController().signal });
    expect(settled?.label).toBe('model');
  });
});
