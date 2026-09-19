import type { SuggestRequest, Suggestion } from '@carat/shared';
import type { Provider, SuggestOptions } from './provider';

/**
 * Two providers under one budget. The fast one (Jev over regex candidates)
 * answers first; the smart one (an LLM) only runs when the fast one returned
 * nothing, whether because it had no candidates, every field came back `none`
 * or under threshold, or it failed outright. Both get the same signal, so the
 * orchestrator's 6s timeout cancels whichever is in flight.
 */
export class FastThenSmartProvider implements Provider {
  readonly id: Provider['id'];

  constructor(
    readonly fast: Provider,
    readonly smart: Provider,
  ) {
    this.id = fast.id;
  }

  async suggest(req: SuggestRequest, opts: SuggestOptions): Promise<Suggestion[]> {
    if (opts.signal.aborted) return [];
    let first: Suggestion[] = [];
    try {
      first = await this.fast.suggest(req, opts);
    } catch {
      // An unreachable fast layer is not a reason to skip the smart one.
    }
    if (first.length > 0 || opts.signal.aborted) return first;
    return this.smart.suggest(req, opts);
  }
}
