import type { NextAction, NextActionRequest, Settings } from '@carat/shared';
import type { NextOptions, Provider } from './provider';

/** One provider's answer, as it lands. */
export interface RaceAnswer {
  provider: Provider['id'];
  action: NextAction;
}

/** How one provider's call went; the same shape the popup's debug line prints. */
export interface RaceAttempt {
  id: Settings['provider'];
  ms: number;
  /** The kind it answered with, or '-' when it had nothing. */
  kind: string;
  error?: string;
}

export interface RaceOptions {
  /** What the race calls itself; the configured provider, so `id === 'local'` checks still mean "regex only". */
  id: Settings['provider'];
  /** Where a throwing provider is reported. Default: console.warn. */
  onError?: (id: Settings['provider'], error: unknown) => void;
}

/**
 * Every provider at once instead of one after another. `first` resolves with
 * the first answer that is not `none`; the regex placeholder is in the list,
 * so that is usually the same tick and a chip is up while the model is still
 * writing. `rest` yields each later answer, in the order they land, and the
 * orchestrator decides whether one replaces what is on screen.
 *
 * One AbortSignal covers all of them: the caller's signal aborts the run,
 * leaving `rest()` early aborts whatever is still in flight, and a new
 * `first()` aborts the previous run. A provider that throws is reported,
 * recorded in `attempts`, and skipped; it never fails the race.
 */
export class RaceProvider implements Provider {
  readonly id: Settings['provider'];
  private run: Run | undefined;

  constructor(
    /** Start order, and rank on a tie: later beats earlier. */
    readonly providers: readonly Provider[],
    private readonly options: RaceOptions,
  ) {
    this.id = options.id;
  }

  /** The first usable answer, or null once every provider is done with nothing. */
  first(req: NextActionRequest, opts: NextOptions): Promise<NextAction | null> {
    this.run?.stop(new DOMException('A new race started', 'AbortError'));
    this.run = new Run(this.providers, req, opts, this.options.onError ?? warn);
    return this.run.first;
  }

  /**
   * Later answers from the run `first()` started. Ends when every provider
   * has settled or the run was aborted. One consumer per run; breaking out
   * aborts the providers still running.
   */
  rest(): AsyncIterable<RaceAnswer> {
    const run = this.run;
    const done = { value: undefined, done: true } as const;
    // Hand-rolled rather than a generator: a generator queues return() behind a pending next(), and a
    // consumer that gives up while waiting for the next answer must still be able to abort the run.
    const iterator: AsyncIterator<RaceAnswer> = {
      async next() {
        if (!run) return done;
        for (;;) {
          const next = run.queue.shift();
          if (next) return { value: next, done: false };
          if (run.ended) return done;
          await new Promise<void>((resolve) => run.waiting.push(resolve));
        }
      },
      async return() {
        run?.stop(new DOMException('The race consumer stopped', 'AbortError'));
        return done;
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  /** How each provider in the current run fared so far, in the order they settled. */
  get attempts(): readonly RaceAttempt[] {
    return this.run?.attempts ?? [];
  }

  /** Whose answer the run is standing on, or undefined while nothing usable has landed. */
  get winner(): Settings['provider'] | undefined {
    return this.run?.bestProvider;
  }

  /** Whether anything in here has a prefix to warm at all: the regex placeholder and Jev have none. */
  get warms(): boolean {
    return this.providers.some((p) => p.warm !== undefined);
  }

  /**
   * Warm every provider that has a prefix to warm; the placeholder and Jev
   * have none, so in practice this is the chat model alone. Never rejects,
   * and never disturbs a run in flight: a warm-up carries its own signal.
   */
  async warm(req: NextActionRequest, opts: { signal: AbortSignal }): Promise<void> {
    await Promise.all(this.providers.map(async (p) => p.warm?.(req, opts).catch(() => undefined)));
  }

  /** The one-call shape: the best answer anything managed inside the signal. */
  async next(req: NextActionRequest, opts: NextOptions): Promise<NextAction | null> {
    await this.first(req, opts);
    for await (const _ of this.rest()) {
      // each answer is already folded into the run
    }
    return this.run?.best ?? null;
  }
}

const warn = (id: Settings['provider'], error: unknown): void => {
  console.warn(`[carat] ${id} provider failed and was skipped:`, error);
};

class Run {
  readonly first: Promise<NextAction | null>;
  readonly queue: RaceAnswer[] = [];
  readonly waiting: Array<() => void> = [];
  readonly attempts: RaceAttempt[] = [];
  ended = false;
  best: NextAction | null = null;
  bestProvider: Settings['provider'] | undefined;

  private readonly controller = new AbortController();
  private resolveFirst!: (a: NextAction | null) => void;
  private firstDone = false;
  private bestRank = -1;
  private settled = 0;
  private readonly detach: () => void;

  constructor(
    private readonly providers: readonly Provider[],
    req: NextActionRequest,
    opts: NextOptions,
    private readonly onError: (id: Settings['provider'], error: unknown) => void,
  ) {
    this.first = new Promise((resolve) => (this.resolveFirst = resolve));
    const onAbort = (): void => this.stop(opts.signal.reason);
    opts.signal.addEventListener('abort', onAbort, { once: true });
    this.detach = () => opts.signal.removeEventListener('abort', onAbort);
    if (opts.signal.aborted) {
      this.stop(opts.signal.reason);
      return;
    }
    providers.forEach((provider, rank) => this.launch(provider, rank, req, opts));
  }

  /** Abort what is still running and close both ends. Idempotent. */
  stop(reason: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.detach();
    this.controller.abort(reason);
    this.finishFirst();
    this.wake();
  }

  private launch(provider: Provider, rank: number, req: NextActionRequest, opts: NextOptions): void {
    const started = Date.now();
    let result: Promise<NextAction | null>;
    try {
      result = provider.next(req, {
        signal: this.controller.signal,
        ...(opts.onPartial ? { onPartial: opts.onPartial } : {}),
        ...(opts.onRaw ? { onRaw: opts.onRaw } : {}),
      });
    } catch (e) {
      result = Promise.reject(e);
    }
    result.then(
      (action) => {
        this.attempts.push({ id: provider.id, ms: Date.now() - started, kind: action?.kind ?? '-' });
        this.land(provider, rank, action);
      },
      (e: unknown) => {
        this.attempts.push({ id: provider.id, ms: Date.now() - started, kind: '-', error: describe(e) });
        if (!this.ended) this.onError(provider.id, e);
        this.land(provider, rank, null);
      },
    );
  }

  private land(provider: Provider, rank: number, action: NextAction | null): void {
    if (this.ended) return;
    const usable = action && action.kind !== 'none';
    if (usable && rank > this.bestRank) {
      this.best = action;
      this.bestRank = rank;
      this.bestProvider = provider.id;
    }
    if (usable && !this.firstDone) this.finishFirst();
    else if (usable) {
      this.queue.push({ provider: provider.id, action: action! });
      this.wake();
    }
    if (++this.settled === this.providers.length) this.stop(undefined);
  }

  private finishFirst(): void {
    if (this.firstDone) return;
    this.firstDone = true;
    this.resolveFirst(this.best);
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'timed out' : e.message || e.name;
  return String(e);
}
