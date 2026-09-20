import { describe, expect, it, vi } from 'vitest';
import type { ContextItem } from '@carat/shared';
import { COMMANDS, clearAll, handleClearCommand } from '../src/background/clear';
import { DEBUG_COMMAND } from '../src/background/debug';
import { HistoryStore } from '../src/background/history';
import { createNotes } from '../src/background/notes';
import { ContextStore, ShotStore, createSettingsStore } from '../src/store';
import type { StorageArea } from '../src/store';
import wxtConfig from '../wxt.config';

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

const TEXT = 'Dinner at Seven Shores Cafe on Friday at 6, and bring the returns slip for order NW-55821. '.repeat(3);

function noted(): ContextItem {
  return {
    id: 'i1',
    tabId: 1,
    origin: 'https://discord.com',
    path: '/channels/1',
    title: 'Waterloo plans',
    kind: 'page',
    text: TEXT,
    hash: 1,
    capturedAt: 0,
    lastSeenAt: 0,
  };
}

/** The four session stores and one local settings store, as the worker builds them. */
async function filled() {
  const session = new FakeArea();
  const local = new FakeArea();
  const store = new ContextStore(session);
  const shots = new ShotStore(session);
  const history = new HistoryStore(session);
  const notes = createNotes({ area: session, distill: async () => ['They asked for the returns slip.'] });
  const settings = createSettingsStore(local);

  await store.upsertPage({ tabId: 1, url: 'https://discord.com/channels/1', title: 'Waterloo plans', text: TEXT });
  await store.pin();
  await shots.put({ tabId: 1, url: 'https://discord.com/channels/1', title: 'plans', dataUrl: 'data:image/jpeg;base64,x', cue: 'thin-text' });
  await history.record(1, { t: Date.now(), kind: 'click', role: 'button', name: 'Reply' });
  await notes.distilNow(noted());
  await notes.flush();
  await settings.set({ apiKey: 'sk-secret', model: 'gpt-5.2', disabledHosts: ['bank.example'] });

  return { session, local, store, shots, history, notes, settings };
}

describe('clearAll', () => {
  it('wipes the context, the pin, the screenshots, the timeline, the notes and the answer cache', async () => {
    const w = await filled();
    expect(Object.keys(w.session.data).length).toBeGreaterThan(0);
    expect(await w.store.isPinned()).toBe(true);

    const cache = vi.fn();
    await clearAll({ store: w.store, shots: w.shots, history: w.history, notes: w.notes, cache });

    expect(cache).toHaveBeenCalledTimes(1);
    expect(await w.store.items()).toEqual([]);
    expect(await w.store.isPinned()).toBe(false);
    expect(await w.shots.live()).toEqual([]);
    expect(await w.history.lines(1)).toEqual([]);
    expect(await w.notes.top({ tabId: 2 })).toEqual([]);
    // Nothing of the session is left behind under any key.
    expect(w.session.data).toEqual({});
  });

  it('leaves settings alone: the key, the model and the per-site switches survive', async () => {
    const w = await filled();
    await clearAll({ store: w.store, shots: w.shots, history: w.history, notes: w.notes, cache: () => undefined });

    const after = await w.settings.get();
    expect(after.apiKey).toBe('sk-secret');
    expect(after.model).toBe('gpt-5.2');
    expect(after.disabledHosts).toEqual(['bank.example']);
    expect(Object.keys(w.local.data)).toEqual(['settings']);
  });
});

describe('the clear shortcut', () => {
  it('wipes first and tells the tab afterwards', async () => {
    const order: string[] = [];
    const notify = vi.fn((_tabId: number) => void order.push('told'));
    const clear = vi.fn(async () => void order.push('cleared'));

    handleClearCommand(COMMANDS.clear, 7, { clear, notify });
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    expect(order).toEqual(['cleared', 'told']);
    expect(notify).toHaveBeenCalledWith(7);
  });

  it('ignores the suggest key, a tab Chrome cannot name, and a clear that throws', async () => {
    const notify = vi.fn();
    const clear = vi.fn(async () => undefined);

    handleClearCommand(COMMANDS.suggest, 7, { clear, notify });
    handleClearCommand(COMMANDS.clear, undefined, { clear, notify });
    expect(clear).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    const failing = vi.fn(async () => Promise.reject(new Error('storage gone')));
    handleClearCommand(COMMANDS.clear, 7, { clear: failing, notify });
    await Promise.resolve();
    await Promise.resolve();
    expect(failing).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('the manifest', () => {
  it('declares all three shortcuts, so Chrome offers them at chrome://extensions/shortcuts', () => {
    const commands = wxtConfig.manifest && 'commands' in wxtConfig.manifest ? wxtConfig.manifest.commands : undefined;
    expect(Object.keys(commands ?? {}).sort()).toEqual([COMMANDS.suggest, COMMANDS.clear, DEBUG_COMMAND].sort());
    expect(commands?.[COMMANDS.suggest]?.suggested_key).toEqual({ default: 'Alt+Shift+C' });
    expect(commands?.[COMMANDS.clear]?.suggested_key).toEqual({ default: 'Alt+Shift+X' });
    expect(commands?.[COMMANDS.clear]?.description).toBe('Clear what Carat remembers');
    expect(commands?.[DEBUG_COMMAND]?.suggested_key).toEqual({ default: 'Alt+Shift+D' });
  });
});
