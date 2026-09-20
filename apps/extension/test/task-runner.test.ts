// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerToContent } from '../src/engine/shared/protocol';
import { DEFAULT_SETTINGS, type Settings } from '../src/engine/shared/settings';

/**
 * The model's answers, queued oldest first. Anything the runner asks for past
 * the end of the queue is "done", so a test that forgets one still finishes.
 */
const model = vi.hoisted(() => ({ answers: [] as string[] }));
const actuate = vi.hoisted(() => ({
  click: vi.fn(async () => ({ ok: true }) as const),
  setValue: vi.fn(async () => ({ ok: true }) as const),
  pressEnter: vi.fn(async () => ({ ok: true }) as const),
  select: vi.fn(async () => ({ ok: true }) as const),
  announceTarget: vi.fn(async () => undefined),
}));
const settings = vi.hoisted(() => ({ current: null as Settings | null }));

vi.mock('../src/engine/background/llm', async (importActual) => ({
  ...(await importActual<typeof import('../src/engine/background/llm')>()),
  streamResponse: vi.fn(async () => ({ text: model.answers.shift() ?? '{"kind":"done","message":"Done."}' })),
}));
vi.mock('../src/engine/background/axmirror', () => ({
  getTree: vi.fn(async () => ({ snapshot: { nodes: [], focusedBackendId: null }, cached: false })),
}));
vi.mock('../src/engine/background/outline', () => ({
  buildOutline: vi.fn(() => ({
    text: 'the page',
    candidates: [
      // [1] is safe and [2] is not, which is the difference the runner turns on.
      { n: 1, backendNodeId: 77, role: 'button', name: 'Departures' },
      { n: 2, backendNodeId: 88, role: 'button', name: 'Place the order' },
    ],
  })),
}));
vi.mock('../src/engine/background/notes', () => ({ notesFor: vi.fn(async () => '(none)') }));
vi.mock('../src/engine/background/history', () => ({
  appendHistory: vi.fn(async () => undefined),
  historyFor: vi.fn(async () => '(none)'),
}));
vi.mock('../src/engine/background/browser', () => ({
  browserContext: vi.fn(async () => ({ text: '(no other tabs)', tabs: [] })),
  openOrSearch: vi.fn(async () => ({ ok: true })),
  switchToTab: vi.fn(async () => ({ ok: true })),
  waitForLoad: vi.fn(async () => undefined),
}));
vi.mock('../src/engine/background/actuate', () => actuate);
vi.mock('../src/engine/shared/settings', async (importActual) => ({
  ...(await importActual<typeof import('../src/engine/shared/settings')>()),
  loadSettings: vi.fn(async () => settings.current!),
}));

const { answerTask, confirmTask, hasTask, resumeTask, startTask, stopTask } = await import(
  '../src/engine/background/task'
);

const TAB = 7;
let sent: WorkerToContent[];

/** Every message the task sent this tab, in order. */
const of = <T extends WorkerToContent['type']>(type: T): Extract<WorkerToContent, { type: T }>[] =>
  sent.filter((m): m is Extract<WorkerToContent, { type: T }> => m.type === type);

const send = (tabId: number, msg: WorkerToContent): void => {
  expect(tabId).toBe(TAB);
  sent.push(msg);
};

/** Let the runner get as far as it can: it awaits between every step. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(2_000).then(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  model.answers = [];
  settings.current = { ...DEFAULT_SETTINGS, enabled: true, apiKey: 'sk-x' };
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => ({ id: TAB, url: 'https://shop.test/cart', status: 'complete' })) },
    storage: { session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    debugger: { onDetach: { addListener: vi.fn() }, onEvent: { addListener: vi.fn() } },
  });
});

afterEach(() => {
  stopTask(TAB);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('a task', () => {
  it('stops when the model says it is done, and says why', async () => {
    model.answers = ['{"kind":"done","message":"Booked."}'];
    void startTask(TAB, 'book the 9am train', 'https://shop.test/cart', send);
    await settle();
    expect(of('task-done')).toEqual([{ type: 'task-done', summary: 'Booked.' }]);
    expect(hasTask(TAB)).toBe(false);
  });

  it('carries out a safe step without asking anyone', async () => {
    model.answers = ['{"kind":"click","target":1,"label":"Departures","why":"the date is set"}'];
    void startTask(TAB, 'book the 9am train', 'https://shop.test/cart', send);
    await settle();
    expect(actuate.click).toHaveBeenCalledWith(TAB, 77);
    expect(of('task-ask')).toEqual([]);
    const steps = of('task-step');
    expect(steps.at(-1)).toMatchObject({ text: 'Click Departures', state: 'done' });
  });

  it('offers an irreversible step instead of doing it, and waits', async () => {
    model.answers = ['{"kind":"click","target":2,"label":"Place the order","irreversible":true}'];
    void startTask(TAB, 'buy it', 'https://shop.test/cart', send);
    await settle();
    expect(actuate.click).not.toHaveBeenCalled();
    expect(of('action')).toMatchObject([{ kind: 'click', label: 'Place the order', irreversible: true }]);
    expect(of('task-ask')[0]?.question).toContain('Place the order');
    expect(of('task-step').at(-1)).toMatchObject({ state: 'waiting' });
    expect(hasTask(TAB)).toBe(true);
  });

  it('does the irreversible step once the user confirms it', async () => {
    model.answers = ['{"kind":"click","target":2,"label":"Place the order","irreversible":true}'];
    void startTask(TAB, 'buy it', 'https://shop.test/cart', send);
    await settle();
    expect(confirmTask(TAB, true)).toBe(true);
    await settle();
    expect(actuate.click).toHaveBeenCalledWith(TAB, 88);
  });

  it('takes a decline as the newest thing it knows and carries on', async () => {
    model.answers = [
      '{"kind":"click","target":2,"label":"Place the order","irreversible":true}',
      '{"kind":"done","message":"Left it for you."}',
    ];
    void startTask(TAB, 'buy it', 'https://shop.test/cart', send);
    await settle();
    confirmTask(TAB, false);
    await settle();
    expect(actuate.click).not.toHaveBeenCalled();
    expect(of('task-step').some((s) => s.state === 'skipped')).toBe(true);
    expect(of('task-done')).toMatchObject([{ summary: 'Left it for you.' }]);
  });

  it('reads a typed correction as a no with a reason', async () => {
    model.answers = [
      '{"kind":"click","target":2,"label":"Place the order","irreversible":true}',
      '{"kind":"done","message":"Changed."}',
    ];
    void startTask(TAB, 'buy it', 'https://shop.test/cart', send);
    await settle();
    answerTask(TAB, 'use the other card first');
    await settle();
    expect(of('task-step').some((s) => (s.why ?? '').includes('use the other card first'))).toBe(true);
  });

  it('asks the user when the model cannot decide, and takes the answer', async () => {
    model.answers = ['{"kind":"ask","message":"Which station?"}', '{"kind":"done","message":"Booked."}'];
    void startTask(TAB, 'book a train', 'https://shop.test/cart', send);
    await settle();
    expect(of('task-ask')).toMatchObject([{ question: 'Which station?' }]);
    answerTask(TAB, 'Waterloo');
    await settle();
    expect(of('task-step').some((s) => s.text.includes('Waterloo'))).toBe(true);
    expect(of('task-done')).toMatchObject([{ summary: 'Booked.' }]);
  });

  it('gives up after two answers it cannot read', async () => {
    model.answers = ['not json at all', 'still not json'];
    void startTask(TAB, 'do a thing', 'https://shop.test/cart', send);
    await settle();
    expect(of('task-done')[0]?.summary).toContain('could not be read');
    expect(hasTask(TAB)).toBe(false);
  });

  it('says so and stops when the control the model named is not on the page', async () => {
    model.answers = ['{"kind":"click","target":9,"label":"Nope"}', '{"kind":"done","message":"Gave up."}'];
    void startTask(TAB, 'do a thing', 'https://shop.test/cart', send);
    await settle();
    expect(of('task-step').some((s) => s.state === 'failed' && s.text.includes('Could not find'))).toBe(true);
  });

  it('will not start without an API key', async () => {
    settings.current = { ...DEFAULT_SETTINGS, enabled: true, apiKey: '' };
    void startTask(TAB, 'do a thing', 'https://shop.test/cart', send);
    await settle();
    expect(of('task-done')[0]?.summary).toContain('No API key');
  });

  it('stops on request, and tells the panel', async () => {
    model.answers = ['{"kind":"ask","message":"Which station?"}'];
    void startTask(TAB, 'book a train', 'https://shop.test/cart', send);
    await settle();
    sent = [];
    stopTask(TAB);
    expect(of('task-done')).toEqual([{ type: 'task-done', summary: 'Stopped.' }]);
    expect(hasTask(TAB)).toBe(false);
  });

  it('rebuilds the panel in a tab that lost it, question and all', async () => {
    model.answers = ['{"kind":"ask","message":"Which station?"}'];
    void startTask(TAB, 'book a train', 'https://shop.test/cart', send);
    await settle();
    const replayed: WorkerToContent[] = [];
    resumeTask(TAB, (msg) => replayed.push(msg));
    expect(replayed[0]).toEqual({ type: 'task-start', goal: 'book a train' });
    expect(replayed.some((m) => m.type === 'task-step')).toBe(true);
    expect(replayed.at(-1)).toEqual({ type: 'task-ask', question: 'Which station?' });
  });

  it('has nothing to say about a tab with no task', () => {
    const replayed: WorkerToContent[] = [];
    resumeTask(4242, (msg) => replayed.push(msg));
    expect(replayed).toEqual([]);
    expect(confirmTask(4242, true)).toBe(false);
    expect(hasTask(4242)).toBe(false);
  });
});
