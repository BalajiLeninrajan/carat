import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The fake browser has no chrome.debugger, and cdp.ts subscribes to it the
 * moment it loads, so these go in before any import of it.
 */
const events = vi.hoisted(() => {
  type Listener = (...args: never[]) => unknown;
  const event = () => {
    const listeners: Listener[] = [];
    return {
      addListener: (l: Listener) => listeners.push(l),
      removeListener: () => undefined,
      hasListener: () => false,
      // Every worker restart in this file adds another listener; only the last set matters.
      fire: (...args: unknown[]) => listeners.slice(-1).forEach((l) => l(...(args as never[]))),
    };
  };
  const fake = globalThis as unknown as { chrome: Record<string, Record<string, unknown>> } & {
    chrome: { tabs: Record<string, unknown>; runtime: Record<string, unknown> };
  };
  const onCommand = event();
  const onDetach = event();
  fake.chrome.debugger = { ...fake.chrome.debugger, onDetach };
  fake.chrome.tabs.onRemoved = event();
  fake.chrome.runtime.onConnect = event();
  fake.chrome.runtime.onInstalled = event();
  fake.chrome.commands = { ...fake.chrome.commands, onCommand };
  return { onCommand, onDetach };
});

import { isPaused, pause } from '../src/engine/background/cdp';

/** Every one-shot message the worker answers, by name, as the popup would reach it. */
const handlers = new Map<string, (msg: { data: unknown; sender: unknown }) => unknown>();
const sendMessage = vi.fn(async () => undefined);

vi.mock('../src/messaging', () => ({
  sendMessage,
  safeSendMessage: sendMessage,
  onMessage: (type: string, fn: (msg: { data: unknown; sender: unknown }) => unknown) => {
    handlers.set(type, fn);
  },
}));

async function startWorker(): Promise<void> {
  const mod = (await import('../entrypoints/background')) as { default: { main: () => void } };
  mod.default.main();
}

const ask = (type: string, data: unknown): unknown => handlers.get(type)!({ data, sender: {} });

describe('a tab paused by the debugging bar', () => {
  beforeEach(async () => {
    handlers.clear();
    sendMessage.mockClear();
    await chrome.storage.session.clear();
    vi.resetModules();
    await startWorker();
  });

  it('tells the popup it is paused, and stops saying so once resumed', async () => {
    expect(await ask('isTabPaused', { tabId: 7 })).toBe(false);
    await pause(7);
    expect(await ask('isTabPaused', { tabId: 7 })).toBe(true);

    await ask('resumeTab', { tabId: 7 });
    expect(await isPaused(7)).toBe(false);
    expect(await ask('isTabPaused', { tabId: 7 })).toBe(false);
  });

  it('asks that tab for a suggestion as soon as it is resumed', async () => {
    await pause(7);
    await ask('resumeTab', { tabId: 7 });
    expect(sendMessage).toHaveBeenCalledWith('forceSuggest', undefined, 7);
  });
});
