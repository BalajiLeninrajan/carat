import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '@carat/shared';
import { DEFAULT_SETTINGS } from '@carat/shared';
import { ContextStore, ShotStore } from '../src/store';
import type { StorageArea } from '../src/store';
import { RefineQueue, createVisionPipeline, downscale } from '../src/background';
import type { ImageEnv, ScreenApi, VisionCue, VisionDeps } from '../src/background';

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

const on: Settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-test', screenshots: true };
// A 1x1 PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TRANSCRIPT = 'alex: dinner at Seven Shores Cafe, Friday at 6? sam: sounds good, see you there';

const cue = (over: Partial<VisionCue> = {}): VisionCue => ({
  action: 'shot',
  url: 'https://discord.com/channels/1?x=1',
  title: 'Discord | #general',
  bodyChars: 120,
  ...over,
});

type TabState = { active: boolean; windowId: number };

function fakeTabs(state: Record<number, TabState | undefined>): ScreenApi & { captures: number; state: typeof state } {
  const tabs = {
    captures: 0,
    state,
    async get(tabId: number) {
      return tabs.state[tabId];
    },
    async captureVisible() {
      tabs.captures++;
      return PNG;
    },
  };
  return tabs;
}

function pipeline(over: Partial<VisionDeps> = {}) {
  const area = new FakeArea();
  const store = new ContextStore(area);
  const shots = new ShotStore(area);
  const transcribe = vi.fn(async () => TRANSCRIPT);
  const tabs = fakeTabs({ 1: { active: true, windowId: 7 } });
  const deps: VisionDeps = {
    store,
    shots,
    settings: async () => on,
    tabs,
    createSmartProvider: () => ({ transcribe }),
    downscale: async (d) => `${d}#small`,
    ...over,
  };
  return { store, shots, tabs, transcribe, deps, vision: createVisionPipeline(deps) };
}

const other = { tabId: 2, origin: 'https://www.google.com' };

describe('vision pipeline', () => {
  it('photographs an active thin tab, downscales it, and keeps it as a shot rather than a context item', async () => {
    const { vision, shots, store, tabs, transcribe } = pipeline();
    await vision.handle(cue(), 1);
    expect(tabs.captures).toBe(1);
    const live = await shots.live();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ tabId: 1, url: 'https://discord.com/channels/1?x=1', dataUrl: `${PNG}#small` });
    expect(await store.items()).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
    expect(vision.hasPending(other)).toBe(false);
  });

  it('ignores a cue when screenshots are off, carat is off, the host is denylisted, the url is not http, or the tab is not in front', async () => {
    const cases: Array<[Partial<VisionDeps>, VisionCue, number]> = [
      [{ settings: async () => ({ ...on, screenshots: false }) }, cue(), 1],
      [{ settings: async () => ({ ...on, enabled: false }) }, cue(), 1],
      [{}, cue({ url: 'https://app.chase.com/x' }), 1],
      [{}, cue({ url: 'chrome://extensions' }), 1],
      [{ tabs: fakeTabs({ 1: { active: false, windowId: 7 } }) }, cue(), 1],
      [{}, cue(), 9],
    ];
    for (const [over, c, tabId] of cases) {
      const { vision, shots, tabs } = pipeline(over);
      await vision.handle(c, tabId);
      expect(tabs.captures).toBe(0);
      expect(await shots.live()).toEqual([]);
    }
  });

  it('takes no picture of a site the user switched off, or while the store is pinned', async () => {
    const off = pipeline({ settings: async () => ({ ...on, disabledHosts: ['discord.com'] }) });
    await off.vision.handle(cue(), 1);
    expect(off.tabs.captures).toBe(0);

    const pinned = pipeline();
    await pinned.store.pin();
    await pinned.vision.handle(cue(), 1);
    expect(pinned.tabs.captures).toBe(0);
    expect(await pinned.shots.live()).toEqual([]);
    // A picture taken before the pin is not read into the store either.
    await pinned.store.unpin();
    await pinned.vision.handle(cue(), 1);
    await pinned.store.pin();
    await pinned.vision.handle(cue({ action: 'leaving' }), 1);
    await pinned.vision.settled();
    expect(pinned.transcribe).not.toHaveBeenCalled();
    expect(await pinned.store.items()).toEqual([]);
  });

  it('reports what became of each cue, per tab, for the popup', async () => {
    const seen: Array<[number, string]> = [];
    const { vision } = pipeline({ onDiag: (tabId, d) => seen.push([tabId, d.verdict]) });
    await vision.handle(cue(), 1);
    await vision.handle(cue(), 9);
    await vision.handle(cue({ url: 'https://app.chase.com/x' }), 1);
    await vision.handle(cue({ action: 'leaving' }), 1);
    await vision.settled();
    await vision.handle(cue({ action: 'leaving' }), 1);
    await vision.settled();
    await vision.handle(cue({ action: 'filling' }), 1);
    expect(seen).toEqual([
      [1, 'shot'],
      [9, 'not-in-front'],
      [1, 'denylisted'],
      [1, 'reading'],
      [1, 'transcribed'],
      [1, 'no-shot'],
      [1, 'dropped'],
    ]);
    const short = pipeline({ onDiag: (_t, d) => seen.push([0, d.verdict]), createSmartProvider: () => ({ transcribe: async () => 'x' }) });
    await short.vision.handle(cue(), 1);
    await short.vision.handle(cue({ action: 'leaving' }), 1);
    await short.vision.settled();
    expect(seen.slice(-2)).toEqual([[0, 'reading'], [0, 'short']]);
  });

  it('drops the picture when the tab changed while it was being taken, and swallows capture errors', async () => {
    const { vision, shots, tabs } = pipeline();
    const originalCapture = tabs.captureVisible.bind(tabs);
    tabs.captureVisible = async () => {
      tabs.state[1] = { active: false, windowId: 7 };
      return originalCapture(7);
    };
    await vision.handle(cue(), 1);
    expect(await shots.live()).toEqual([]);

    const failing = pipeline();
    failing.tabs.captureVisible = async () => {
      throw new Error('Tabs cannot be captured this often');
    };
    await expect(failing.vision.handle(cue(), 1)).resolves.toBeUndefined();
    expect(await failing.shots.live()).toEqual([]);
  });

  it('reads the shot when the tab is left: the image goes, a vision item stays', async () => {
    const { vision, shots, store, transcribe } = pipeline();
    await vision.handle(cue(), 1);
    await vision.handle(cue({ action: 'leaving' }), 1);
    expect(vision.hasPending(other)).toBe(true);
    expect(vision.hasPending({ tabId: 1, origin: 'https://discord.com' })).toBe(false);
    await vision.settled();
    expect(vision.hasPending(other)).toBe(false);

    expect(transcribe).toHaveBeenCalledTimes(1);
    const [image, opts] = transcribe.mock.calls[0] as unknown as [{ dataUrl: string; title: string; host: string }, { signal: AbortSignal }];
    expect(image).toEqual({ dataUrl: `${PNG}#small`, title: 'Discord | #general', host: 'discord.com' });
    expect(opts.signal).toBeInstanceOf(AbortSignal);

    const items = await store.items();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'vision', tabId: 1, origin: 'https://discord.com', path: '/channels/1' });
    expect(items[0]!.text).toBe(`Discord | #general · discord.com ${TRANSCRIPT}`);
    expect(await shots.live()).toEqual([]);
  });

  it('keeps nothing when there is no shot, the transcript is short, there is no smart provider, or the model fails', async () => {
    const none = pipeline();
    await none.vision.handle(cue({ action: 'leaving' }), 1);
    await none.vision.settled();
    expect(none.transcribe).not.toHaveBeenCalled();

    for (const over of [
      { createSmartProvider: () => ({ transcribe: async () => 'too short' }) },
      { createSmartProvider: () => undefined },
      {
        createSmartProvider: () => ({
          transcribe: async () => {
            throw new Error('HTTP 500');
          },
        }),
      },
    ] as Partial<VisionDeps>[]) {
      const { vision, shots, store } = pipeline(over);
      await vision.handle(cue(), 1);
      await vision.handle(cue({ action: 'leaving' }), 1);
      await vision.settled();
      expect(await store.items()).toEqual([]);
      expect(await shots.live()).toEqual([]);
    }
  });

  it("a 'filling' cue deletes the tab's shot so the page being filled is never read", async () => {
    const { vision, shots, transcribe } = pipeline();
    await vision.handle(cue(), 1);
    await vision.handle(cue({ action: 'filling' }), 1);
    expect(await shots.live()).toEqual([]);
    await vision.handle(cue({ action: 'leaving' }), 1);
    await vision.settled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('never blocks on the model: handle() returns while a slow transcription is still pending', async () => {
    let finish!: (text: string) => void;
    const { vision, store } = pipeline({
      createSmartProvider: () => ({ transcribe: () => new Promise<string>((resolve) => (finish = resolve)) }),
    });
    await vision.handle(cue(), 1);
    const started = performance.now();
    await vision.handle(cue({ action: 'leaving' }), 1);
    expect(performance.now() - started).toBeLessThan(50);
    expect(vision.hasPending(other)).toBe(true);
    // A second leave while the first read is in flight does not start another.
    await vision.handle(cue({ action: 'leaving' }), 1);
    await new Promise((r) => setTimeout(r, 0));
    finish(TRANSCRIPT);
    await vision.settled();
    expect((await store.items()).map((i) => i.kind)).toEqual(['vision']);
  });
});

function fakeEnv(width: number, height: number) {
  const drawn: number[][] = [];
  const sizes: number[][] = [];
  let closed = 0;
  class Canvas {
    constructor(
      public width: number,
      public height: number,
    ) {
      sizes.push([width, height]);
    }
    getContext() {
      return { drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => drawn.push([x, y, w, h]) };
    }
    async convertToBlob(opts: { type: string }) {
      return new Blob([new Uint8Array([1, 2, 3])], { type: opts.type });
    }
  }
  const env: ImageEnv = {
    createImageBitmap: async () => ({ width, height, close: () => closed++ }) as unknown as ImageBitmap,
    OffscreenCanvas: Canvas as unknown as ImageEnv['OffscreenCanvas'],
  };
  return { env, drawn, sizes, closed: () => closed };
}

describe('downscale', () => {
  it('passes the image through where the canvas APIs are missing or the input is not a data URL', async () => {
    expect(await downscale(PNG, {})).toBe(PNG);
    expect(await downscale('https://x.test/a.png', fakeEnv(4000, 3000).env)).toBe('https://x.test/a.png');
  });

  it('scales the long edge to 1024, re-encodes as JPEG, and closes the bitmap', async () => {
    const fake = fakeEnv(2560, 1440);
    const out = await downscale(PNG, fake.env);
    expect(fake.sizes).toEqual([[1024, 576]]);
    expect(fake.drawn).toEqual([[0, 0, 1024, 576]]);
    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(fake.closed()).toBe(1);
  });

  it('leaves a small JPEG alone but still re-encodes a small PNG', async () => {
    const jpeg = 'data:image/jpeg;base64,/9j/4AAQ';
    const fake = fakeEnv(800, 600);
    expect(await downscale(jpeg, fake.env)).toBe(jpeg);
    expect(fake.sizes).toEqual([]);
    const out = await downscale(PNG, fake.env);
    expect(fake.sizes).toEqual([[800, 600]]);
    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

describe('RefineQueue', () => {
  const answer = { suggestions: [{ kind: 'fill' as const, fieldId: 'f0', value: 'x', confidence: 0.9, reason: '', sourceContextId: 'c' }], interactions: [] };
  const none = { suggestions: [], interactions: [] };

  it('answers a ticket once, and only for the tab it was issued to', async () => {
    const queue = new RefineQueue(() => undefined);
    const ticket = queue.add(4, Promise.resolve(answer));
    expect(queue.add(4, Promise.resolve(answer))).not.toBe(ticket);
    expect(await queue.claim(ticket, 5)).toEqual(none);
    expect(await queue.claim('nope', 4)).toEqual(none);
    expect(await queue.claim(ticket, 4)).toEqual(answer);
    expect(await queue.claim(ticket, 4)).toEqual(none);
  });

  it('turns a failed smart call into nothing and forgets an unclaimed ticket after the grace period', async () => {
    const timers: Array<() => void> = [];
    const queue = new RefineQueue((fn) => timers.push(fn));
    const ticket = queue.add(1, Promise.reject(new Error('boom')));
    await Promise.resolve();
    await Promise.resolve();
    expect(await queue.claim(ticket, 1)).toEqual(none);
    const kept = queue.add(1, Promise.resolve(answer));
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.size).toBe(1);
    timers.forEach((fn) => fn());
    expect(queue.size).toBe(0);
    expect(await queue.claim(kept, 1)).toEqual(none);
  });
});
