import { describe, expect, it, vi } from 'vitest';
import type { SuggestRequest, Suggestion } from '@carat/shared';
import type { Provider } from '../src/provider';
import { RaceProvider, type RaceAnswer } from '../src/race';

const req: SuggestRequest = {
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' },
  fields: [{ i: 'f0', t: 'input:text', al: 'Search Google Maps' }],
  context: [{ id: 'c1', origin: 'https://discord.com', title: 'Discord', kind: 'page', text: 'dinner at Seven Shores Cafe?', capturedAt: 1 }],
  now: '2026-09-16T14:04:00-04:00',
};

const fill = (value: string, confidence: number, fieldId = 'f0'): Suggestion => ({ kind: 'fill', fieldId, value, confidence, reason: 'r', sourceContextId: 'c1' });
const values = (s: Suggestion[]) => s.map((x) => `${x.kind === 'fill' ? x.fieldId : '?'}=${x.value}@${x.confidence}`);

/** A provider whose answer the test releases by hand; `sync` answers inside suggest() itself, as the regex one does. */
function fake(id: Provider['id'], answer?: Suggestion[] | Error) {
  let release!: (s: Suggestion[]) => void;
  let fail!: (e: unknown) => void;
  const gate = new Promise<Suggestion[]>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const p = {
    id,
    calls: 0,
    signals: [] as AbortSignal[],
    resolve: release,
    reject: fail,
    async suggest(_req: SuggestRequest, opts: { signal: AbortSignal }) {
      p.calls++;
      p.signals.push(opts.signal);
      if (answer instanceof Error) throw answer;
      if (answer) return answer;
      return gate;
    },
  };
  return p;
}

const local = (answer: Suggestion[] = [fill('Seven Shores Cafe', 0.75)]) => fake('local', answer);

async function collect(iter: AsyncIterable<RaceAnswer>, max = Infinity): Promise<RaceAnswer[]> {
  const out: RaceAnswer[] = [];
  for await (const a of iter) {
    out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('RaceProvider', () => {
  it('resolves first() with the regex answer before a network provider has answered', async () => {
    const regex = local();
    const chat = fake('openai');
    const race = new RaceProvider([regex, chat], { id: 'openai' });
    let settled = false;
    const first = race.first(req, new AbortController().signal).then((s) => {
      settled = true;
      return s;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(values(await first)).toEqual(['f0=Seven Shores Cafe@0.75']);
    expect(chat.calls).toBe(1);
    expect(race.attempts.map((a) => a.id)).toEqual(['local']);
  });

  it('yields a surer later chat answer through rest(), merged over the first', async () => {
    const regex = local([fill('Seven Shores Cafe', 0.75), fill('Waterloo', 0.75, 'f1')]);
    const chat = fake('openai');
    const race = new RaceProvider([regex, chat], { id: 'openai' });
    const first = await race.first(req, new AbortController().signal);
    expect(values(first)).toEqual(['f0=Seven Shores Cafe@0.75', 'f1=Waterloo@0.75']);
    const pending = collect(race.rest());
    chat.resolve([fill('Seven Shores Café', 0.92)]);
    const later = await pending;
    expect(later).toHaveLength(1);
    expect(later[0]!.provider).toBe('openai');
    expect(values(later[0]!.suggestions)).toEqual(['f0=Seven Shores Café@0.92', 'f1=Waterloo@0.75']);
    expect(race.attempts.map((a) => [a.id, a.count])).toEqual([
      ['local', 2],
      ['openai', 1],
    ]);
  });

  it('never lets a lower-confidence later answer displace the one shown', async () => {
    const regex = local();
    const chat = fake('openai');
    const race = new RaceProvider([regex, chat], { id: 'openai' });
    await race.first(req, new AbortController().signal);
    const pending = collect(race.rest());
    chat.resolve([fill('Somewhere Else', 0.7)]);
    expect(await pending).toEqual([]);
    expect(race.attempts.map((a) => a.count)).toEqual([1, 1]);
  });

  it('breaks an equal-confidence tie in favour of the provider started later: chat over Jev over regex', async () => {
    const regex = local([fill('Regex', 0.8)]);
    const jev = fake('cloudflare');
    const chat = fake('openai');
    const race = new RaceProvider([regex, jev, chat], { id: 'cloudflare' });
    await race.first(req, new AbortController().signal);
    const pending = collect(race.rest());
    chat.resolve([fill('Chat', 0.8)]);
    await tick();
    jev.resolve([fill('Jev', 0.8)]);
    const later = await pending;
    expect(later.map((a) => [a.provider, values(a.suggestions)])).toEqual([['openai', ['f0=Chat@0.8']]]);
  });

  it('skips a provider that throws, sync or async, and keeps racing', async () => {
    const onError = vi.fn();
    const regex = local([]);
    const jev = fake('cloudflare', new Error('HTTP 502'));
    const chat = fake('openai');
    const race = new RaceProvider([regex, jev, chat], { id: 'cloudflare', onError });
    const first = race.first(req, new AbortController().signal);
    await tick();
    expect(onError).toHaveBeenCalledWith('cloudflare', expect.objectContaining({ message: 'HTTP 502' }));
    chat.resolve([fill('From the model', 0.9)]);
    expect(values(await first)).toEqual(['f0=From the model@0.9']);
    expect(await collect(race.rest())).toEqual([]);
    expect(race.attempts.map((a) => [a.id, a.error ?? ''])).toEqual([
      ['local', ''],
      ['cloudflare', 'HTTP 502'],
      ['openai', ''],
    ]);
  });

  it('resolves first() with [] when every provider comes back empty or broken', async () => {
    const race = new RaceProvider([local([]), fake('openai', new Error('down'))], { id: 'openai', onError: () => {} });
    expect(await race.first(req, new AbortController().signal)).toEqual([]);
    expect(await collect(race.rest())).toEqual([]);
  });

  it('hands every provider one signal and aborts them all when the caller stops consuming rest()', async () => {
    const regex = local();
    const jev = fake('cloudflare');
    const chat = fake('openai');
    const race = new RaceProvider([regex, jev, chat], { id: 'cloudflare' });
    await race.first(req, new AbortController().signal);
    expect(new Set([...regex.signals, ...jev.signals, ...chat.signals]).size).toBe(1);
    const iter = race.rest()[Symbol.asyncIterator]();
    const next = iter.next();
    await iter.return?.();
    expect(chat.signals[0]!.aborted).toBe(true);
    expect((await next).done).toBe(true);
    // A straggler that ignores the abort changes nothing once the run is over.
    chat.resolve([fill('Too late', 0.99)]);
    await tick();
    expect(await collect(race.rest())).toEqual([]);
  });

  it("aborts the providers when the caller's signal fires, and first() settles with what it has", async () => {
    const controller = new AbortController();
    const regex = local([]);
    const chat = fake('openai');
    const race = new RaceProvider([regex, chat], { id: 'openai' });
    const first = race.first(req, controller.signal);
    const pending = collect(race.rest());
    await tick();
    controller.abort(new DOMException('budget', 'TimeoutError'));
    expect(chat.signals[0]!.aborted).toBe(true);
    expect(chat.signals[0]!.reason.name).toBe('TimeoutError');
    expect(await first).toEqual([]);
    expect(await pending).toEqual([]);
  });

  it('starts nothing on a signal that is already aborted', async () => {
    const chat = fake('openai');
    const race = new RaceProvider([local(), chat], { id: 'openai' });
    expect(await race.first(req, AbortSignal.abort())).toEqual([]);
    expect(chat.calls).toBe(0);
    expect(await collect(race.rest())).toEqual([]);
  });

  it('with only the regex provider first() resolves at once and rest() ends', async () => {
    const race = new RaceProvider([local()], { id: 'local' });
    let settled = false;
    const first = race.first(req, new AbortController().signal).then((s) => {
      settled = true;
      return s;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(values(await first)).toEqual(['f0=Seven Shores Cafe@0.75']);
    expect(await collect(race.rest())).toEqual([]);
  });

  it('yields nothing from rest() before first() and aborts a previous run when first() is called again', async () => {
    const chat = fake('openai');
    const race = new RaceProvider([local(), chat], { id: 'openai' });
    expect(await collect(race.rest())).toEqual([]);
    await race.first(req, new AbortController().signal);
    const old = chat.signals[0]!;
    await race.first(req, new AbortController().signal);
    expect(old.aborted).toBe(true);
    expect(chat.calls).toBe(2);
  });

  it('suggest() waits for everything inside the signal and returns the merged view, never a rejection', async () => {
    const regex = local([fill('Seven Shores Cafe', 0.75), fill('Waterloo', 0.75, 'f1')]);
    const chat = fake('openai');
    const broken = fake('cloudflare', new Error('HTTP 500'));
    const race = new RaceProvider([regex, broken, chat], { id: 'cloudflare', onError: () => {} });
    const out = race.suggest(req, { signal: new AbortController().signal });
    await tick();
    chat.resolve([fill('Seven Shores Café', 0.9)]);
    expect(values(await out)).toEqual(['f0=Seven Shores Café@0.9', 'f1=Waterloo@0.75']);

    // Out of budget: the regex answer is what there is.
    const slow = fake('openai');
    const controller = new AbortController();
    const bounded = new RaceProvider([local(), slow], { id: 'openai' }).suggest(req, { signal: controller.signal });
    await tick();
    controller.abort();
    expect(values(await bounded)).toEqual(['f0=Seven Shores Cafe@0.75']);
  });
});
