// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/engine/shared/settings';
import { downsample, encodeWav, toBase64 } from '../src/engine/offscreen/listen';

type RecordHeard = (lines: string[], context: string[], settings: Settings) => Promise<void>;
const { recordHeard } = vi.hoisted(() => ({ recordHeard: vi.fn<RecordHeard>(async () => undefined) }));
vi.mock('../src/engine/background/notes', () => ({ recordHeard }));

/** The offscreen document's messages, as the worker sees them. */
type Listener = (msg: unknown) => void;

interface Harness {
  /** Play one utterance in, which the fake API transcribes to the next queued line. */
  say: (text: string, seconds?: number) => Promise<void>;
  /** Move Chrome's focus off every window, past the grace period. */
  unfocus: () => Promise<void>;
  createDocument: ReturnType<typeof vi.fn>;
  closeDocument: ReturnType<typeof vi.fn>;
  /** Messages the worker sent the document, which is how the microphone is driven. */
  sent: ReturnType<typeof vi.fn>;
  fetchImpl: ReturnType<typeof vi.fn>;
  settings: Settings;
}

/** Let the module's pending promises settle without moving the clock on. */
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined);

async function harness(over: Partial<Settings> = {}): Promise<Harness> {
  const settings: Settings = { ...DEFAULT_SETTINGS, enabled: true, apiKey: 'sk-x', listenEnabled: true, ...over };
  let onMessage: Listener | undefined;
  let onFocusChanged: ((windowId: number) => void) | undefined;
  let open = false;

  const createDocument = vi.fn(async () => {
    open = true;
  });
  const closeDocument = vi.fn(async () => {
    open = false;
  });
  /** Each transcription answers with the text of the utterance that asked for it. */
  const spoken: string[] = [];
  const fetchImpl = vi.fn(async () => Response.json({ text: spoken.shift() ?? '' }));
  const sent = vi.fn(async () => undefined);

  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: (fn: Listener) => (onMessage = fn) },
      sendMessage: sent,
      getContexts: async () => (open ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
      getURL: (path: string) => `chrome-extension://carat/${path}`,
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
    },
    windows: {
      onFocusChanged: { addListener: (fn: (windowId: number) => void) => (onFocusChanged = fn) },
      getLastFocused: async () => ({ focused: true }),
      WINDOW_ID_NONE: -1,
    },
    storage: {
      onChanged: { addListener: () => undefined },
      local: { get: async () => settings },
    },
    offscreen: {
      createDocument,
      closeDocument,
      hasDocument: async () => open,
      Reason: { USER_MEDIA: 'USER_MEDIA', CLIPBOARD: 'CLIPBOARD' },
    },
    action: {
      setBadgeBackgroundColor: async () => undefined,
      setBadgeText: async () => undefined,
      setTitle: async () => undefined,
    },
  });

  await import('../src/engine/background/listen');
  await settle(); // the initial getLastFocused, and the reconcile it triggers

  return {
    settings,
    createDocument,
    closeDocument,
    sent,
    fetchImpl,
    say: async (text, seconds = 5) => {
      spoken.push(text);
      onMessage?.({ type: 'carat-utterance', wav: btoa('wav bytes'), seconds });
      await settle();
    },
    unfocus: async () => {
      onFocusChanged?.(-1);
      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
    },
  };
}

/** The pause after which the worker turns what it has into notes. */
const PAUSE_MS = 20_000;

describe('background listening', () => {
  beforeEach(() => {
    vi.resetModules();
    recordHeard.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds speech until the talking stops, then notes it', async () => {
    const h = await harness();

    await h.say('dinner with Alex on Friday at six');
    await vi.advanceTimersByTimeAsync(PAUSE_MS - 1_000);
    expect(recordHeard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(recordHeard).toHaveBeenCalledTimes(1);
    expect(recordHeard).toHaveBeenCalledWith(['dinner with Alex on Friday at six'], [], h.settings);
  });

  it('notes one batch, not one note per line', async () => {
    const h = await harness();

    await h.say('book the flight');
    await vi.advanceTimersByTimeAsync(5_000);
    await h.say('the one leaving Thursday');
    await vi.advanceTimersByTimeAsync(PAUSE_MS);
    await settle();

    expect(recordHeard).toHaveBeenCalledTimes(1);
    expect(recordHeard.mock.calls[0]?.[0]).toEqual(['book the flight', 'the one leaving Thursday']);
  });

  it('does not wait for a pause once two minutes of speech has piled up', async () => {
    const h = await harness();

    await h.say('a long story', 70);
    expect(recordHeard).not.toHaveBeenCalled();

    await h.say('still going', 70); // 140s of speech, past the cap
    await settle();
    expect(recordHeard).toHaveBeenCalledTimes(1);
    expect(recordHeard.mock.calls[0]?.[0]).toEqual(['a long story', 'still going']);
  });

  it('carries the last few noted lines over as context for the next batch', async () => {
    const h = await harness();

    for (const line of ['one', 'two', 'three', 'four']) await h.say(line);
    await vi.advanceTimersByTimeAsync(PAUSE_MS);
    await settle();
    expect(recordHeard.mock.calls[0]?.[1]).toEqual([]);

    await h.say('five');
    await vi.advanceTimersByTimeAsync(PAUSE_MS);
    await settle();

    expect(recordHeard).toHaveBeenCalledTimes(2);
    expect(recordHeard.mock.calls[1]?.[0]).toEqual(['five']);
    // Three lines of context, and they are the tail of what was noted before.
    expect(recordHeard.mock.calls[1]?.[1]).toEqual(['two', 'three', 'four']);
  });

  it('sends nothing anywhere without an API key', async () => {
    const h = await harness({ apiKey: '' });

    await h.say('something private');
    await vi.advanceTimersByTimeAsync(PAUSE_MS);
    await settle();

    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(recordHeard).not.toHaveBeenCalled();
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  it('drops what a speech model says into near-silence', async () => {
    const h = await harness();

    await h.say('Thanks for watching!', 1.5);
    await vi.advanceTimersByTimeAsync(PAUSE_MS);
    await settle();

    expect(recordHeard).not.toHaveBeenCalled();
  });

  it('asks for the microphone only while listening is on', async () => {
    const off = await harness({ listenEnabled: false });
    expect(off.createDocument).not.toHaveBeenCalled();
    expect(off.sent).not.toHaveBeenCalled();

    vi.resetModules();
    vi.unstubAllGlobals();
    const on = await harness();
    // One document serves the clipboard too, so it is stated with both reasons.
    expect(on.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'offscreen.html', reasons: ['CLIPBOARD', 'USER_MEDIA'] }),
    );
    // The document being up is not the microphone being open: that is asked for.
    expect(on.sent).toHaveBeenCalledWith({ type: 'carat-listen-start' });
  });

  it('gives the microphone back when Chrome loses focus, and notes what was said first', async () => {
    const h = await harness();
    await h.say('leave the microphone out of it now');

    await h.unfocus();

    // The microphone goes first, then the document, since nothing else wants it.
    expect(h.sent).toHaveBeenCalledWith({ type: 'carat-listen-stop' });
    expect(h.closeDocument).toHaveBeenCalledTimes(1);
    await settle();
    expect(recordHeard).toHaveBeenCalledTimes(1);
  });
});

describe('offscreen audio helpers', () => {
  it('average-decimates down to the target rate', () => {
    const input = Float32Array.from([1, 1, 0, 0, 1, 1, -1, -1]);
    expect([...downsample(input, 2)]).toEqual([1, 0, 1, -1]);
  });

  it('writes a mono 16-bit PCM WAV header for the samples it was given', () => {
    const wav = encodeWav([Float32Array.from([0, 1, -1, 0.5])], 16_000);
    const v = new DataView(wav.buffer);
    const tag = (o: number): string => String.fromCharCode(...wav.subarray(o, o + 4));

    expect(wav.length).toBe(44 + 4 * 2);
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(v.getUint32(4, true)).toBe(36 + 4 * 2);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000); // byte rate
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(4 * 2);
    // Full scale clamps to the ends of the range, not past them.
    expect(v.getInt16(46, true)).toBe(0x7fff);
    expect(v.getInt16(48, true)).toBe(-0x8000);
  });

  it('base64s a whole buffer, past the chunk it copies at a time', () => {
    const bytes = new Uint8Array(0x8000 + 5).fill(65);
    expect(atob(toBase64(bytes)).length).toBe(bytes.length);
  });
});
