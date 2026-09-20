import type { ChatMessage, Settings } from '@carat/shared';
import { normalizeWhitespace, truncate } from '@carat/shared';
import type { StorageArea } from '../store/storage-area';

/** Session key for the goal, beside the notes and the timeline. */
export const GOAL_KEY = 'goal';

export const GOAL_LIMITS = {
  /** A goal is one line the user would recognise, not a paragraph. */
  chars: 120,
  /** How long a goal stands without a fresh derivation behind it. */
  ttlMs: 30 * 60_000,
  /** One derivation per this much, however many notes and chips land in between. */
  everyMs: 20_000,
  /** Notes the derivation reads, newest first. */
  notes: 8,
  /** Timeline lines the derivation reads, across every tab. */
  history: 12,
  /** Room for one line and nothing else. */
  maxTokens: 40,
  /** Consecutive "none" answers that drop the goal. */
  noneToClear: 2,
  /** How long the derivation has before it is given up on. */
  timeoutMs: 6000,
} as const;

/** What the model answers when the user is browsing rather than getting something done. */
export const GOAL_NONE = 'none';

/**
 * The goal as it sits in `chrome.storage.session`. `at` is the last
 * derivation: the thirty-minute life and the twenty-second rate limit both
 * run from it, so a run that answers "none" still holds the limit down.
 */
export interface Goal {
  /** The line itself, or '' once the model has answered "none" twice running. */
  text: string;
  at: number;
  /** Consecutive derivations that answered "none". */
  misses: number;
}

/**
 * One small chat call on the same provider that distills notes: messages in,
 * the reply's text out. Never rejects; '' when there is no model behind it.
 * A seam, because the provider package is not this module's to change.
 */
export type GoalAsk = (messages: ChatMessage[], opts: { signal: AbortSignal; maxTokens: number }) => Promise<string>;

export interface GoalDeps {
  area: StorageArea;
  /** The newest distilled facts, across every tab. */
  notes: (n: number) => Promise<string[]>;
  /** The last timeline lines, across every tab, oldest first. */
  history: (n: number) => Promise<string[]>;
  /** Without one the goal never changes; everything else still works. */
  ask?: GoalAsk;
  now?: () => number;
  timeoutMs?: number;
}

export interface GoalStore {
  /** The line the request carries, or undefined when there is none. */
  current(at?: number): Promise<string | undefined>;
  /**
   * A notes distillation or an accepted action just happened. Rate-limited;
   * resolves to the goal in force afterwards, which may be the old one.
   */
  derive(at?: number): Promise<string | undefined>;
  /** The user dropped it from the popup, or a clear wiped everything. */
  clear(): Promise<void>;
  /** Resolves once every queued write has landed. */
  flush(): Promise<void>;
}

/**
 * One sentence for what the user is trying to get done, held across tabs.
 * Notes say what they read and the timeline says what they did, but a flow
 * that runs over three sites — search flights, pick a fare, pay on the
 * airline — has no single thing the model is answering against. This is that
 * thing: derived after each notes distillation and each accepted chip, kept
 * for half an hour, and dropped once two derivations running find nothing
 * behind the browsing.
 *
 * It rides in the request as `goal` and in the prompt as a `<goal>` block in
 * front of `<notes>`, which puts it inside the cached prefix. A goal that
 * changes therefore misses the provider's prefix cache once, and the
 * warm-up on the next navigation pays it back.
 */
export function createGoal(deps: GoalDeps): GoalStore {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? GOAL_LIMITS.timeoutMs;
  let chain: Promise<unknown> = Promise.resolve();

  async function read(at: number): Promise<Goal | undefined> {
    const raw = (await deps.area.get([GOAL_KEY]))[GOAL_KEY];
    const held = asGoal(raw);
    if (!held || at - held.at >= GOAL_LIMITS.ttlMs) return undefined;
    return held;
  }

  function write(next: Goal): Promise<void> {
    const step = chain.then(() => deps.area.set({ [GOAL_KEY]: next }));
    chain = step.catch(() => undefined);
    return step;
  }

  /**
   * `skipped` when there was nothing to ask about and no call went out;
   * `failed` when one did and came back empty, aborted or unreadable. The two
   * differ in what they cost: a failed call still spends the rate limit.
   */
  async function ask(held: Goal | undefined): Promise<{ answer: string } | 'skipped' | 'failed'> {
    if (!deps.ask) return 'skipped';
    const [notes, history] = await Promise.all([
      deps.notes(GOAL_LIMITS.notes).catch(() => []),
      deps.history(GOAL_LIMITS.history).catch(() => []),
    ]);
    // Nothing read and nothing done is nothing to infer a goal from.
    if (notes.length === 0 && history.length === 0) return 'skipped';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const reply = await deps.ask(goalMessages(notes, history, held?.text || undefined), {
        signal: controller.signal,
        maxTokens: GOAL_LIMITS.maxTokens,
      });
      const answer = readGoalReply(reply);
      return answer ? { answer } : 'failed';
    } catch {
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async current(at = now()) {
      const held = await read(at);
      return held?.text || undefined;
    },

    async derive(at = now()) {
      const held = await read(at);
      // A burst of tab switches is one errand; the limit holds whether or not
      // the last run found a goal, because `at` moves on every run.
      if (held && at - held.at < GOAL_LIMITS.everyMs) return held.text || undefined;
      const result = await ask(held);
      if (result === 'skipped') return held?.text || undefined;
      // A call that came back with nothing is not the model saying "none":
      // only an answer counts against a goal that may still be true. The
      // clock still moves, so a provider that is down is asked once per limit.
      const next =
        result === 'failed'
          ? { text: held?.text ?? '', at, misses: held?.misses ?? 0 }
          : nextGoal(held, result.answer, at);
      await write(next);
      return next.text || undefined;
    },

    clear() {
      const step = chain.then(() => deps.area.remove([GOAL_KEY]));
      chain = step.catch(() => undefined);
      return step;
    },

    flush: () => chain.then(() => undefined),
  };
}

/** What one answer does to the goal on file. Pure, so the rule is testable on its own. */
export function nextGoal(held: Goal | undefined, answer: string, at: number): Goal {
  if (answer !== GOAL_NONE) return { text: answer, at, misses: 0 };
  const misses = (held?.misses ?? 0) + 1;
  return { text: misses >= GOAL_LIMITS.noneToClear ? '' : (held?.text ?? ''), at, misses };
}

/**
 * Small and thoughtless by design: it runs after every tab switch and every
 * accepted chip, so no reasoning and room for one line of output.
 */
export const GOAL_PROMPT = [
  'You keep one sentence for a browser assistant: what the user is trying to get done at the moment, across all their tabs.',
  '',
  'You get the facts the assistant distilled from pages the user read, the last things they did in their tabs, and the goal you wrote last time if there is one.',
  '',
  '- Write it in the user\'s own terms, as an errand they would say they are on: "book a flight ZRH to LON on Friday, cheapest", "find where to eat pan-fried buns near Waterloo".',
  `- One line, at most ${GOAL_LIMITS.chars} characters. No quotes, no full stop, no explanation.`,
  '- Keep the goal you wrote last time, reworded at most, while the user is still working on it. Replace it only once they have clearly moved on to something else, and narrow it as they commit to specifics.',
  `- Answer exactly \`${GOAL_NONE}\` when there is no errand behind this, only reading or browsing.`,
  '',
  'Reply with the line alone.',
].join('\n');

/** The derivation's two messages: the standing prompt, then what there is to go on. */
export function goalMessages(notes: readonly string[], history: readonly string[], current?: string): ChatMessage[] {
  return [
    { role: 'system', content: GOAL_PROMPT },
    {
      role: 'user',
      content: [
        block('notes', notes),
        block('recent', history),
        block('goal', current ? [current] : []),
      ].join('\n'),
    },
  ];
}

/**
 * The reply as a goal: the first line, unquoted and clipped, or `none` when
 * the model said so. An empty or unreadable reply is '' — a provider with
 * nothing to say must not be able to erode a goal that is still true.
 */
export function readGoalReply(reply: string): string {
  const line = normalizeWhitespace((reply ?? '').split('\n').find((l) => l.trim().length > 0) ?? '');
  const bare = line.replace(/^["'`]+|["'`.]+$/g, '').trim();
  if (!bare) return '';
  return bare.toLowerCase() === GOAL_NONE ? GOAL_NONE : truncate(bare, GOAL_LIMITS.chars);
}

function block(name: string, lines: readonly string[]): string {
  return `<${name}>\n${lines.length ? lines.map((l) => `- ${l}`).join('\n') : '(none)'}\n</${name}>`;
}

function asGoal(v: unknown): Goal | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const g = v as Partial<Goal>;
  if (typeof g.text !== 'string' || typeof g.at !== 'number' || !Number.isFinite(g.at)) return undefined;
  return { text: g.text, at: g.at, misses: typeof g.misses === 'number' ? g.misses : 0 };
}

/**
 * The derivation call, against the same OpenAI-compatible endpoint and key the
 * notes distiller uses, with the same model and no reasoning. Undefined when
 * there is no model at all, which is also when there is no goal.
 *
 * It is here rather than on `VisionProvider` only because the provider package
 * was not this change's to touch; fold it in when it is, and `GoalAsk` is the
 * shape to implement.
 */
export function createGoalAsk(settings: Settings, fetchImpl: typeof fetch = fetch): GoalAsk | undefined {
  if (settings.provider === 'local' || !settings.apiKey) return undefined;
  const base = settings.baseURL.replace(/\/$/, '');
  const model = settings.smartModel || settings.model;
  // Only OpenAI's own endpoint is known to take reasoning_effort; a vLLM or Baseten server may 400 on it.
  const effort = isOpenAI(settings.baseURL) ? { reasoning_effort: 'none' } : {};
  return async (messages, opts) => {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model, messages, max_completion_tokens: opts.maxTokens, ...effort }),
      signal: opts.signal,
    });
    if (!res.ok) return '';
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  };
}

function isOpenAI(baseURL: string): boolean {
  try {
    return new URL(baseURL).host === 'api.openai.com';
  } catch {
    return false;
  }
}
