import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
import type { GoalAsk } from '../src/background/goal';
import { GOAL_KEY, GOAL_LIMITS, GOAL_NONE, createGoal, createGoalAsk, goalMessages, nextGoal, readGoalReply } from '../src/background/goal';
import type { StorageArea } from '../src/store';

class FakeArea implements StorageArea {
  data: Record<string, unknown> = {};
  async get(keys: string[]) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.data, structuredClone(items));
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k];
  }
}

const NOTES = ['Swiss lists ZRH to LHR on Friday from CHF 118. (read 3m ago on google.com/travel)'];
const LINES = ['2m ago: [tab 7] filled searchbox "Where to" with "London"'];
const FLIGHT = 'book a flight ZRH to LON on Friday, cheapest';

function setup(
  over: {
    ask?: GoalAsk | null;
    notes?: string[];
    history?: string[];
    start?: number;
  } = {},
) {
  let clock = over.start ?? 1_000_000;
  const area = new FakeArea();
  const notes = vi.fn(async (n: number) => (over.notes ?? NOTES).slice(0, n));
  const history = vi.fn(async (n: number) => (over.history ?? LINES).slice(-n));
  const ask = over.ask === null ? undefined : (over.ask ?? vi.fn<GoalAsk>().mockResolvedValue(FLIGHT));
  const goal = createGoal({
    area,
    notes,
    history,
    ...(ask ? { ask } : {}),
    now: () => clock,
    timeoutMs: 50,
  });
  return { area, goal, notes, history, ask: ask as ReturnType<typeof vi.fn<GoalAsk>>, tick: (ms: number) => (clock += ms) };
}

describe('the goal', () => {
  it('derives one line from the newest notes, the timeline across tabs and the goal it already has', async () => {
    const { goal, notes, history, ask } = setup();

    expect(await goal.derive()).toBe(FLIGHT);
    expect(notes).toHaveBeenCalledWith(GOAL_LIMITS.notes);
    expect(history).toHaveBeenCalledWith(GOAL_LIMITS.history);

    const [messages, opts] = ask.mock.calls[0]!;
    expect(opts.maxTokens).toBe(GOAL_LIMITS.maxTokens);
    const turn = (messages as ChatMessage[]).at(-1)!.content;
    expect(turn).toContain(NOTES[0]);
    expect(turn).toContain(LINES[0]);
    // Nothing to carry forward on the first run.
    expect(turn).toContain('<goal>\n(none)\n</goal>');

    // The second run is shown what it wrote, so it can keep or narrow it.
    ask.mockResolvedValue('book the CHF 118 Swiss fare ZRH to LHR on Friday');
    await goal.flush();
    expect(await goal.derive(1_000_000 + GOAL_LIMITS.everyMs + 1)).toBe('book the CHF 118 Swiss fare ZRH to LHR on Friday');
    expect((ask.mock.calls[1]![0] as ChatMessage[]).at(-1)!.content).toContain(`<goal>\n- ${FLIGHT}\n</goal>`);
  });

  it('derives at most once every twenty seconds, however often it is asked', async () => {
    const { goal, ask, tick } = setup();
    await goal.derive();
    expect(ask).toHaveBeenCalledTimes(1);

    tick(GOAL_LIMITS.everyMs - 1);
    expect(await goal.derive()).toBe(FLIGHT);
    await goal.derive();
    await goal.derive();
    expect(ask).toHaveBeenCalledTimes(1);

    tick(2);
    await goal.derive();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('holds the line for half an hour and lets it go after', async () => {
    const { goal, tick } = setup();
    await goal.derive();
    tick(GOAL_LIMITS.ttlMs - 1);
    expect(await goal.current()).toBe(FLIGHT);
    tick(2);
    expect(await goal.current()).toBeUndefined();
  });

  it('clips a long line to 120 characters and strips the quotes a model puts round it', async () => {
    const long = 'x'.repeat(200);
    const { goal } = setup({ ask: vi.fn<GoalAsk>().mockResolvedValue(`"${long}"`) });
    const derived = await goal.derive();
    expect(derived).toHaveLength(GOAL_LIMITS.chars);
    expect(derived?.startsWith('"')).toBe(false);
  });

  it('drops the goal on the second "none" in a row, not the first', async () => {
    const ask = vi.fn<GoalAsk>().mockResolvedValue(FLIGHT);
    const { goal, tick } = setup({ ask });
    await goal.derive();

    ask.mockResolvedValue('none');
    tick(GOAL_LIMITS.everyMs + 1);
    await goal.derive();
    // One "none" may be a quiet minute in the middle of an errand.
    expect(await goal.current()).toBe(FLIGHT);

    tick(GOAL_LIMITS.everyMs + 1);
    await goal.derive();
    expect(await goal.current()).toBeUndefined();
  });

  it('starts the count again as soon as a goal comes back', async () => {
    const ask = vi.fn<GoalAsk>().mockResolvedValue(FLIGHT);
    const { goal, tick } = setup({ ask });
    await goal.derive();
    ask.mockResolvedValue('none');
    tick(GOAL_LIMITS.everyMs + 1);
    await goal.derive();
    ask.mockResolvedValue(FLIGHT);
    tick(GOAL_LIMITS.everyMs + 1);
    await goal.derive();

    ask.mockResolvedValue('none');
    tick(GOAL_LIMITS.everyMs + 1);
    await goal.derive();
    expect(await goal.current()).toBe(FLIGHT);
  });

  it('never lets a failed call erode a goal that may still be true', async () => {
    const ask = vi.fn<GoalAsk>().mockResolvedValue(FLIGHT);
    const { goal, tick } = setup({ ask });
    await goal.derive();

    ask.mockRejectedValue(new Error('no route to host'));
    for (let i = 0; i < 4; i++) {
      tick(GOAL_LIMITS.everyMs + 1);
      await goal.derive();
    }
    expect(await goal.current()).toBe(FLIGHT);
    // The clock still moved on each attempt, so a server that is down is asked once per limit.
    expect(ask).toHaveBeenCalledTimes(5);
  });

  it('asks nothing when there is no model and nothing to go on', async () => {
    const withoutModel = setup({ ask: null });
    expect(await withoutModel.goal.derive()).toBeUndefined();
    expect(withoutModel.notes).not.toHaveBeenCalled();

    const empty = setup({ notes: [], history: [] });
    expect(await empty.goal.derive()).toBeUndefined();
    expect(empty.ask).not.toHaveBeenCalled();
  });

  it('is dropped outright by a clear, and by the popup cross', async () => {
    const { area, goal } = setup();
    await goal.derive();
    await goal.flush();
    expect(area.data[GOAL_KEY]).toBeDefined();

    await goal.clear();
    expect(area.data[GOAL_KEY]).toBeUndefined();
    expect(await goal.current()).toBeUndefined();
  });

  it('ignores a record session storage came back with in the wrong shape', async () => {
    const { area, goal } = setup();
    area.data[GOAL_KEY] = { text: 12, at: 'soon' };
    expect(await goal.current()).toBeUndefined();
  });
});

describe('reading one answer', () => {
  it('takes the first line, unquoted, and reads an empty reply as nothing rather than "none"', () => {
    expect(readGoalReply(`  ${FLIGHT}.\nand then some\n`)).toBe(FLIGHT);
    expect(readGoalReply('NONE')).toBe(GOAL_NONE);
    expect(readGoalReply('')).toBe('');
    expect(readGoalReply('   \n  ')).toBe('');
  });

  it('counts a "none" and replaces on anything else', () => {
    const held = { text: FLIGHT, at: 0, misses: 0 };
    expect(nextGoal(held, 'find brunch in Waterloo', 5)).toEqual({ text: 'find brunch in Waterloo', at: 5, misses: 0 });
    expect(nextGoal(held, GOAL_NONE, 5)).toEqual({ text: FLIGHT, at: 5, misses: 1 });
    expect(nextGoal({ ...held, misses: 1 }, GOAL_NONE, 5)).toEqual({ text: '', at: 5, misses: 2 });
  });

  it('names the three inputs in the turn and nothing else', () => {
    const turn = goalMessages(NOTES, LINES, FLIGHT).at(-1)!.content;
    expect(turn.indexOf('<notes>')).toBeLessThan(turn.indexOf('<recent>'));
    expect(turn.indexOf('<recent>')).toBeLessThan(turn.indexOf('<goal>'));
  });
});

describe('the derivation call', () => {
  it('is nothing at all without a model', () => {
    expect(createGoalAsk({ ...DEFAULT_SETTINGS, provider: 'local' })).toBeUndefined();
    expect(createGoalAsk({ ...DEFAULT_SETTINGS, apiKey: '' })).toBeUndefined();
  });

  it('sends one short, unreasoned call to the same endpoint the distiller uses', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: FLIGHT } }] }), { status: 200 }),
    );
    const ask = createGoalAsk({ ...DEFAULT_SETTINGS, apiKey: 'k', model: 'gpt-5' }, fetchImpl as unknown as typeof fetch)!;
    const reply = await ask(goalMessages(NOTES, LINES), { signal: AbortSignal.timeout(1000), maxTokens: GOAL_LIMITS.maxTokens });

    expect(reply).toBe(FLIGHT);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(GOAL_LIMITS.maxTokens);
    expect(body.reasoning_effort).toBe('none');
  });

  it('leaves reasoning_effort off a server that is not OpenAI, which may reject it', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }));
    const ask = createGoalAsk(
      { ...DEFAULT_SETTINGS, apiKey: 'k', baseURL: 'https://model.example/v1' },
      fetchImpl as unknown as typeof fetch,
    )!;
    expect(await ask([], { signal: AbortSignal.timeout(1000), maxTokens: 40 })).toBe('');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('reasoning_effort');
  });
});
