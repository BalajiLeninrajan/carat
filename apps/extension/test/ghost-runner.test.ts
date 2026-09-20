import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@carat/shared';
import type { CompleteOptions, CompleteRequest } from '@carat/providers';
import type { GhostDiag } from '../src/background/diag';
import type { Completer, GhostCaller } from '../src/background/ghost';
import { createGhostRunner } from '../src/background/ghost';

const caller: GhostCaller = { tabId: 7, host: 'discord.com', path: '/channels/1/2' };

const input = {
  id: 'g1',
  prefix: 'Dinner at Seven',
  outline: 'main:\n  [1] textbox "Message"',
  singleLine: true,
};

/** A completer whose stream the test drives token by token. */
function scripted() {
  let push: ((piece: string) => void) | null = null;
  let finish: ((whole: string) => void) | null = null;
  let seen: CompleteRequest | null = null;
  const completer: Completer = {
    complete(req: CompleteRequest, opts: CompleteOptions) {
      seen = req;
      let soFar = '';
      push = (piece) => {
        soFar += piece;
        opts.onDelta?.(soFar);
      };
      return new Promise<string>((resolve) => {
        finish = (whole) => resolve(whole);
      });
    },
  };
  return {
    completer,
    request: () => seen,
    token: (piece: string) => push!(piece),
    done: (whole: string) => finish!(whole),
  };
}

function runner(over: { settings?: Partial<Settings>; completer?: Completer | undefined; onDiag?: (tabId: number, d: GhostDiag) => void } = {}) {
  const diags: GhostDiag[] = [];
  const r = createGhostRunner({
    settings: async () => ({ ...DEFAULT_SETTINGS, apiKey: 'k', ...over.settings }),
    notes: async () => ['Dinner at Seven Shores Cafe on Friday at 6.'],
    completer: () => over.completer,
    onDiag: (tabId, d) => {
      diags.push(d);
      over.onDiag?.(tabId, d);
    },
  });
  return { runner: r, diags };
}

describe('the ghost runner', () => {
  it('answers with the first token and says more is coming, then closes with the whole thing', async () => {
    const model = scripted();
    const { runner: r } = runner({ completer: model.completer });

    const first = r.handle(input, caller);
    await Promise.resolve();
    await Promise.resolve();
    model.token(' Shores');
    expect(await first).toEqual({ text: ' Shores', more: true });

    const second = r.handle({ ...input, have: ' Shores'.length }, caller);
    await Promise.resolve();
    model.token(' Cafe');
    expect(await second).toEqual({ text: ' Shores Cafe', more: true });

    const third = r.handle({ ...input, have: ' Shores Cafe'.length }, caller);
    model.done(' Shores Cafe');
    expect(await third).toEqual({ text: ' Shores Cafe', more: false });
  });

  it('is exempt from the grounding a fill goes through: a continuation is the user’s own sentence', async () => {
    const model = scripted();
    const { runner: r } = runner({ completer: model.completer });
    const first = r.handle({ ...input, prefix: 'The place I mean is ' }, caller);
    await Promise.resolve();
    await Promise.resolve();
    // Nothing in the notes, the outline or the timeline says this, and the
    // ghost hands it over anyway: the user is mid-sentence, not being offered
    // a value out of somewhere they have been.
    model.token('somewhere nobody wrote down');
    expect(await first).toEqual({ text: 'somewhere nobody wrote down', more: true });
  });

  it('carries the notes, the outline and the field name to the model', async () => {
    const model = scripted();
    const { runner: r } = runner({ completer: model.completer });
    const call = r.handle({ ...input, field: 'Message' }, caller);
    await Promise.resolve();
    await Promise.resolve();
    model.done(' Shores Cafe');
    await call;
    expect(model.request()).toMatchObject({
      prefix: 'Dinner at Seven',
      outline: input.outline,
      notes: ['Dinner at Seven Shores Cafe on Friday at 6.'],
      field: 'Message',
      singleLine: true,
      maxTokens: 24,
      page: { host: 'discord.com', path: '/channels/1/2' },
    });
  });

  it('gives a textarea the bigger cap', async () => {
    const model = scripted();
    const { runner: r } = runner({ completer: model.completer });
    const call = r.handle({ ...input, singleLine: false }, caller);
    await Promise.resolve();
    await Promise.resolve();
    model.done('x');
    await call;
    expect(model.request()!.maxTokens).toBe(48);
  });

  it('answers nothing with the toggle off, and never reaches the model', async () => {
    const model = scripted();
    const complete = vi.spyOn(model.completer, 'complete');
    const { runner: r, diags } = runner({ completer: model.completer, settings: { ghost: false } });
    expect(await r.handle(input, caller)).toEqual({ text: '', more: false });
    expect(complete).not.toHaveBeenCalled();
    expect(diags.at(-1)).toMatchObject({ verdict: 'off' });
  });

  it('answers nothing when carat is off', async () => {
    const { runner: r, diags } = runner({ completer: scripted().completer, settings: { enabled: false } });
    expect(await r.handle(input, caller)).toEqual({ text: '', more: false });
    expect(diags.at(-1)).toMatchObject({ verdict: 'disabled' });
  });

  it('answers nothing on a site the user switched off', async () => {
    const { runner: r, diags } = runner({ completer: scripted().completer, settings: { disabledHosts: ['discord.com'] } });
    expect(await r.handle(input, caller)).toEqual({ text: '', more: false });
    expect(diags.at(-1)).toMatchObject({ verdict: 'site-off' });
  });

  it('answers nothing when there is no chat model to ask', async () => {
    const { runner: r, diags } = runner({ completer: undefined });
    expect(await r.handle(input, caller)).toEqual({ text: '', more: false });
    expect(diags.at(-1)).toMatchObject({ verdict: 'no-model' });
  });

  it('reports an empty answer as its own verdict, which is what hands Tab back', async () => {
    const model = scripted();
    const { runner: r, diags } = runner({ completer: model.completer });
    const call = r.handle(input, caller);
    await Promise.resolve();
    await Promise.resolve();
    model.done('   ');
    expect(await call).toEqual({ text: '   ', more: false });
    await r.idle();
    expect(diags.at(-1)).toMatchObject({ verdict: 'empty', typed: 'Dinner at Seven'.length });
  });

  it('logs how long the answer took and how much it wrote, never what was typed', async () => {
    const model = scripted();
    const { runner: r, diags } = runner({ completer: model.completer });
    const call = r.handle(input, caller);
    await Promise.resolve();
    await Promise.resolve();
    model.token(' Shores Cafe');
    model.done(' Shores Cafe');
    await call;
    await r.idle();
    const last = diags.at(-1)!;
    expect(last).toMatchObject({ verdict: 'answered', host: 'discord.com', chars: ' Shores Cafe'.length, typed: 15 });
    expect(JSON.stringify(last)).not.toContain('Dinner');
  });

  it('aborts the last pause when a new one asks, because the user has typed on', async () => {
    let aborted = false;
    const completer: Completer = {
      complete: (_req, opts) =>
        new Promise<string>((resolve) => {
          opts.signal.addEventListener('abort', () => {
            aborted = true;
            resolve('');
          });
        }),
    };
    const { runner: r } = runner({ completer });
    void r.handle(input, caller);
    await Promise.resolve();
    await Promise.resolve();
    void r.handle({ ...input, id: 'g2', prefix: 'Dinner at Seven S' }, caller);
    await Promise.resolve();
    await Promise.resolve();
    expect(aborted).toBe(true);
  });

  it('answers a poll on an id it has already drained with nothing, rather than asking again', async () => {
    const model = scripted();
    const { runner: r } = runner({ completer: model.completer });
    const call = r.handle(input, caller);
    await Promise.resolve();
    await Promise.resolve();
    model.done(' Shores Cafe');
    await call;
    expect(await r.handle({ ...input, have: 12 }, caller)).toEqual({ text: '', more: false });
  });
});
