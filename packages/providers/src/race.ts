import type { Settings, SuggestRequest, Suggestion } from '@carat/shared';
import type { Provider, SuggestOptions } from './provider';

/** One provider's answer folded into everything that landed before it. */
export interface RaceAnswer {
  /** The provider whose answer changed the picture. */
  provider: Provider['id'];
  /** The merged, ranked view after that answer: every slot's best, surest first. A full replacement, not a delta. */
  suggestions: Suggestion[];
}

/** How one provider's call went; the same shape the popup's debug line prints. */
export interface RaceAttempt {
  id: Settings['provider'];
  ms: number;
  count: number;
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
 * the first non-empty answer; the regex provider is in the list, so that is
 * usually the same tick. `rest` yields each later answer that improved on
 * what was known, merged over everything so far, so the orchestrator can push
 * it through the refine ticket as it lands.
 *
 * Merge rule, per slot (a field, an element, or an intent and value): the
 * higher confidence wins; on equal confidence the provider later in the list
 * wins (the factory orders them local, Jev, chat), and a full tie keeps what
 * is there. A later answer never displaces an earlier one with lower
 * confidence. Dismissed fields are the caller's problem.
 *
 * One AbortSignal covers all of them. The caller's signal aborts the run;
 * leaving `rest()` early aborts whatever is still in flight; a new `first()`
 * on the same instance aborts the previous run. A provider that throws is
 * reported, recorded in `attempts`, and skipped; it never fails the race.
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

  /**
   * The first non-empty answer, or [] once every provider is done or the
   * signal fires with nothing to show. `onUnderFloor` reaches every provider
   * in the race, so under-floor drops from all of them are counted.
   */
  first(req: SuggestRequest, signal: AbortSignal, onUnderFloor?: SuggestOptions['onUnderFloor']): Promise<Suggestion[]> {
    this.run?.stop(new DOMException('A new race started', 'AbortError'));
    this.run = new Run(this.providers, req, signal, onUnderFloor, this.options.onError ?? warn);
    return this.run.first;
  }

  /**
   * Later answers from the run `first()` started, each one the merged view
   * after it landed, only when it changed a slot. Ends when every provider
   * has settled or the run was aborted. One consumer per run; breaking out
   * aborts the providers still running. Before any `first()` it yields
   * nothing.
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

  /**
   * The one-call shape the orchestrator still uses: everything that answers
   * inside the signal, merged. As slow as the slowest provider that finishes
   * in time, but never worse than the regex answer, and never a rejection.
   * The fast path is `first()` then `rest()`.
   */
  async suggest(req: SuggestRequest, opts: SuggestOptions): Promise<Suggestion[]> {
    await this.first(req, opts.signal, opts.onUnderFloor);
    // Drain, so the run ends with every provider settled or aborted; the merged view is what we want.
    for await (const _ of this.rest()) {
      // each yield is already folded into the run
    }
    return this.run?.view() ?? [];
  }
}

const warn = (id: Settings['provider'], error: unknown): void => {
  console.warn(`[carat] ${id} provider failed and was skipped:`, error);
};

interface Ranked {
  suggestion: Suggestion;
  rank: number;
}

class Run {
  readonly first: Promise<Suggestion[]>;
  readonly queue: RaceAnswer[] = [];
  readonly waiting: Array<() => void> = [];
  readonly attempts: RaceAttempt[] = [];
  ended = false;

  private readonly controller = new AbortController();
  private readonly best = new Map<string, Ranked>();
  private resolveFirst!: (s: Suggestion[]) => void;
  private firstDone = false;
  private settled = 0;
  private readonly detach: () => void;

  constructor(
    private readonly providers: readonly Provider[],
    req: SuggestRequest,
    signal: AbortSignal,
    private readonly onUnderFloor: SuggestOptions['onUnderFloor'],
    private readonly onError: (id: Settings['provider'], error: unknown) => void,
  ) {
    this.first = new Promise((resolve) => (this.resolveFirst = resolve));
    const onAbort = (): void => this.stop(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    this.detach = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) {
      this.stop(signal.reason);
      return;
    }
    providers.forEach((provider, rank) => this.launch(provider, rank, req));
  }

  /** Every slot's best, surest first. */
  view(): Suggestion[] {
    return [...this.best.values()].map((r) => r.suggestion).sort((a, b) => b.confidence - a.confidence);
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

  private launch(provider: Provider, rank: number, req: SuggestRequest): void {
    const started = Date.now();
    let result: Promise<Suggestion[]>;
    try {
      result = provider.suggest(req, { signal: this.controller.signal, onUnderFloor: this.onUnderFloor });
    } catch (e) {
      result = Promise.reject(e);
    }
    result.then(
      (suggestions) => {
        this.attempts.push({ id: provider.id, ms: Date.now() - started, count: suggestions.length });
        this.land(provider, rank, suggestions);
      },
      (e: unknown) => {
        this.attempts.push({ id: provider.id, ms: Date.now() - started, count: 0, error: describe(e) });
        if (!this.ended) this.onError(provider.id, e);
        this.land(provider, rank, []);
      },
    );
  }

  private land(provider: Provider, rank: number, suggestions: Suggestion[]): void {
    if (this.ended) return;
    const changed = this.merge(suggestions, rank);
    if (suggestions.length > 0 && !this.firstDone) {
      this.finishFirst();
    } else if (changed) {
      this.queue.push({ provider: provider.id, suggestions: this.view() });
      this.wake();
    }
    if (++this.settled === this.providers.length) this.stop(undefined);
  }

  private merge(suggestions: Suggestion[], rank: number): boolean {
    let changed = false;
    for (const suggestion of suggestions) {
      const key = slotOf(suggestion);
      const prev = this.best.get(key);
      if (prev && !beats(suggestion, rank, prev)) continue;
      this.best.set(key, { suggestion, rank });
      changed = true;
    }
    return changed;
  }

  private finishFirst(): void {
    if (this.firstDone) return;
    this.firstDone = true;
    this.resolveFirst(this.view());
  }

  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

/** Higher confidence wins; on equal confidence the higher rank; a full tie keeps what is there. */
function beats(s: Suggestion, rank: number, prev: Ranked): boolean {
  if (s.confidence !== prev.suggestion.confidence) return s.confidence > prev.suggestion.confidence;
  return rank > prev.rank;
}

function slotOf(s: Suggestion): string {
  switch (s.kind) {
    case 'fill':
      return `f|${s.fieldId}`;
    case 'interact':
      return `e|${s.elementId}`;
    case 'action':
      return `a|${s.intent}|${s.value}`;
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'timed out' : e.message || e.name;
  return String(e);
}
