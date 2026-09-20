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
      // Every worker restart in this file leaves its listener behind; they all
      // do the same idempotent thing, so fire the lot.
      fire: (...args: unknown[]) => Promise.all(listeners.map((l) => l(...(args as never[])))),
    };
  };
  const fake = globalThis as unknown as { chrome: Record<string, Record<string, unknown>> } & {
    chrome: { tabs: Record<string, unknown>; runtime: Record<string, unknown> };
  };
  const onCommand = event();
  const onDetach = event();
  const onCommitted = event();
  fake.chrome.debugger = { ...fake.chrome.debugger, onDetach };
  fake.chrome.tabs.onRemoved = event();
  fake.chrome.runtime.onConnect = event();
  fake.chrome.runtime.onInstalled = event();
  fake.chrome.commands = { ...fake.chrome.commands, onCommand };
  fake.chrome.webNavigation = { ...fake.chrome.webNavigation, onCommitted };
  return { onCommand, onCommitted, onDetach };
});

import { COMMANDS } from '../entrypoints/background';
import { isPaused, pause } from '../src/engine/background/cdp';

/** Every one-shot message the worker answers, by name, as the popup would reach it. */
const { handlers, sendMessage } = vi.hoisted(() => ({
  handlers: new Map<string, (msg: { data: unknown; sender: unknown }) => unknown>(),
  sendMessage: vi.fn(async () => undefined),
}));

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

  it('is resumed by Alt+Shift+C as well, before the question goes out', async () => {
    await pause(7);
    await events.onCommand.fire(COMMANDS.suggest, { id: 7 });
    expect(await isPaused(7)).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith('forceSuggest', undefined, 7);
  });

  describe('and then navigated away', () => {
    const commit = async (url: string, frameId = 0): Promise<void> => {
      await events.onCommitted.fire({ tabId: 7, frameId, url, transitionType: 'link', transitionQualifiers: [] });
      // The listener answers off the event loop, so let its storage write land.
      await new Promise((r) => setTimeout(r, 0));
    };

    beforeEach(() => {
      // The page the banner was dismissed over.
      vi.spyOn(chrome.tabs, 'get').mockImplementation((async () => ({ url: 'https://paused.test/a' })) as never);
    });

    it('stays paused while the user is still on that site', async () => {
      await pause(7);
      await commit('https://paused.test/b');
      expect(await isPaused(7)).toBe(true);
    });

    it('comes back when the tab goes to another origin', async () => {
      await pause(7);
      await commit('https://elsewhere.test/');
      expect(await isPaused(7)).toBe(false);
    });

    it('ignores subframes, which are not the user leaving', async () => {
      await pause(7);
      await commit('https://ads.elsewhere.test/frame', 3);
      expect(await isPaused(7)).toBe(true);
    });
  });
});
