import type { Settings } from '@carat/shared';
import { LIMITS, ghostMaxTokens, isDenylisted } from '@carat/shared';
import type { CompleteRequest, CompleteOptions } from '@carat/providers';
import { createCompleter } from '@carat/providers';
import { isSiteOff } from '../store';
import type { GhostDiag, GhostVerdict } from './diag';

/** What the page asks for, and what it asks again with to get the rest of it. */
export interface GhostInput {
  /** One id per pause. The same id polls for more of the same answer. */
  id: string;
  /** What the user has typed up to the caret. */
  prefix: string;
  /** What follows the caret in the same field, when anything does. */
  suffix?: string;
  /** The viewport outline the action path last built here. */
  outline: string;
  /** The field's accessible name, when it has one. */
  field?: string;
  /** An input rather than a textarea or an editor. */
  singleLine: boolean;
  /** Characters of this answer the page has already drawn; the reply waits for more than this. */
  have?: number;
}

export interface GhostReply {
  /** The continuation so far, cleaned. */
  text: string;
  /** More may still arrive; ask again with the same id. */
  more: boolean;
}

/** Whose page is asking, for the site gate and the prompt cache key. */
export interface GhostCaller {
  tabId?: number;
  host: string;
  path: string;
}

/** The one thing the runner needs of a provider. */
export interface Completer {
  complete(req: CompleteRequest, opts: CompleteOptions): Promise<string>;
}

export interface GhostDeps {
  settings(): Promise<Settings>;
  /** The notes the next-action path would have sent, for this tab. */
  notes(tabId: number | undefined): Promise<string[]>;
  /** Overridden in tests; by default the fast chat model with no reasoning. */
  completer?(s: Settings): Completer | undefined;
  onDiag?(tabId: number, d: GhostDiag): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
}

export interface GhostRunner {
  handle(input: GhostInput, caller: GhostCaller): Promise<GhostReply>;
  /** Resolves once every request this runner started has finished; the tests drive it. */
  idle(): Promise<void>;
}

/** An answer the page is still reading out. */
interface Entry {
  text: string;
  done: boolean;
  waiting: Array<() => void>;
  abort: AbortController;
  tabId: number | undefined;
}

/** A started answer nobody came back for is dropped after this. */
const GRACE_MS = 15_000;

const NOTHING: GhostReply = { text: '', more: false };

/**
 * The ghost, from the service worker's side. The first call on an id starts
 * one streamed completion and returns as soon as there is a token to draw;
 * every call after it waits for more text than the page already has, and the
 * last one says `more: false`. One answer at a time per tab: a new id aborts
 * whatever the old one was still writing, because the user has typed on.
 *
 * Nothing here ever rejects. A model that fails, a site that is off and a
 * setting that is off all come back as an empty answer, which is the page's
 * signal to give Tab back to the action chip.
 */
export function createGhostRunner(deps: GhostDeps): GhostRunner {
  const open = new Map<string, Entry>();
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const completerFor = deps.completer ?? ((s: Settings) => createCompleter(s));
  let running: Promise<unknown> = Promise.resolve();

  function note(caller: GhostCaller, verdict: GhostVerdict, typed: number, extra: Partial<GhostDiag> = {}): void {
    if (caller.tabId === undefined) return;
    deps.onDiag?.(caller.tabId, { at: now(), host: caller.host, verdict, typed, ...extra });
  }

  /** The user has typed on, so whatever the last pause asked for is no longer wanted. */
  function abortOthers(tabId: number | undefined, keep: string): void {
    for (const [id, entry] of open) {
      if (id === keep || entry.tabId !== tabId) continue;
      entry.abort.abort();
      entry.done = true;
      for (const wake of entry.waiting.splice(0)) wake();
      open.delete(id);
    }
  }

  async function start(input: GhostInput, caller: GhostCaller): Promise<Entry | null> {
    const typed = input.prefix.length;
    const refuse = (verdict: GhostVerdict): null => {
      note(caller, verdict, typed);
      return null;
    };
    const settings = await deps.settings();
    if (!settings.enabled) return refuse('disabled');
    if (!settings.ghost) return refuse('off');
    if (isSiteOff(settings, caller.host)) return refuse('site-off');
    if (caller.host && isDenylisted(caller.host.split(':')[0]!)) return refuse('denylisted');
    const model = completerFor(settings);
    if (!model) return refuse('no-model');

    abortOthers(caller.tabId, input.id);
    const entry: Entry = { text: '', done: false, waiting: [], abort: new AbortController(), tabId: caller.tabId };
    open.set(input.id, entry);

    const wake = (): void => {
      for (const resolve of entry.waiting.splice(0)) resolve();
    };
    const startedAt = now();
    let firstMs: number | undefined;
    // The ghost is a phrase, not an essay; it gets the same budget the engine has.
    const timer = setTimer(() => entry.abort.abort(), LIMITS.providerTimeoutMs);
    const request: CompleteRequest = {
      prefix: input.prefix,
      ...(input.suffix ? { suffix: input.suffix } : {}),
      outline: input.outline,
      notes: await deps.notes(caller.tabId),
      ...(input.field ? { field: input.field } : {}),
      singleLine: input.singleLine,
      maxTokens: ghostMaxTokens(input.singleLine),
      page: { host: caller.host, path: caller.path },
    };
    const call = model
      .complete(request, {
        signal: entry.abort.signal,
        onDelta: (soFar) => {
          if (firstMs === undefined && soFar !== '') firstMs = now() - startedAt;
          entry.text = soFar;
          wake();
        },
      })
      .then(
        (text) => {
          entry.text = text;
          note(caller, text.trim() === '' ? 'empty' : 'answered', typed, {
            chars: text.length,
            ...(firstMs !== undefined ? { firstMs } : {}),
            ms: now() - startedAt,
          });
        },
        () => {
          note(caller, 'failed', typed, { ms: now() - startedAt });
        },
      )
      .finally(() => {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
        entry.done = true;
        wake();
        // A page that navigated away mid-answer must not pin this forever.
        setTimer(() => open.delete(input.id), GRACE_MS);
      });
    running = running.then(() => call);
    return entry;
  }

  return {
    async handle(input, caller) {
      const found = open.get(input.id);
      // An id that has already been drained is a poll after the last word.
      const entry = found ?? (input.have === undefined ? await start(input, caller) : null);
      if (!entry) return NOTHING;
      const have = input.have ?? 0;
      while (entry.text.length <= have && !entry.done) {
        await new Promise<void>((resolve) => entry.waiting.push(resolve));
      }
      if (entry.done) {
        open.delete(input.id);
        return { text: entry.text, more: false };
      }
      return { text: entry.text, more: true };
    },
    idle: () => running.then(() => undefined),
  };
}
