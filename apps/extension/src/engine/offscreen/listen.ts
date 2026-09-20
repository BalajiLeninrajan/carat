/**
 * Microphone listener, running in an offscreen document (service workers
 * cannot capture audio). The document is shared with the clipboard reader, so
 * being open is not the signal: the worker says start and stop, and stopping
 * releases the device whether or not the page stays up.
 *
 * Voice-activity detection is a simple adaptive energy gate: it tracks the
 * room's noise floor while nobody is talking and opens when the level rises
 * well above it. Speech is cut into utterances at pauses, downsampled to 16 kHz
 * mono, encoded as WAV and handed to the worker for transcription. Silence is
 * never sent anywhere.
 */

export const TARGET_RATE = 16_000;
/** Audio kept from just before speech started, so the first syllable is not clipped. */
const PRE_ROLL_MS = 300;
/** A pause this long ends an utterance. */
const END_SILENCE_MS = 900;
/** Shorter bursts (a cough, a door) are dropped. */
const MIN_SPEECH_MS = 600;
/** Long monologues are cut here so transcripts keep flowing. */
const MAX_UTTERANCE_MS = 30_000;
/** The gate never opens below this RMS, however quiet the room. */
const MIN_THRESHOLD = 0.012;

function send(msg: object): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/** Average-decimate to the target rate. */
export function downsample(input: Float32Array, ratio: number): Float32Array {
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export function encodeWav(chunks: Float32Array[], rate: number): Uint8Array {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, c[i]!));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Uint8Array(buf);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** What a running capture holds, so stopping can give all of it back. */
interface Live {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  proc: ScriptProcessorNode;
  beat: ReturnType<typeof setInterval>;
}
let live: Live | null = null;

/** Whether the microphone is open right now. */
export function listening(): boolean {
  return live !== null;
}

/** Let go of the microphone. Safe to call when it was never taken. */
export async function stop(): Promise<void> {
  const l = live;
  if (!l) return;
  live = null;
  clearInterval(l.beat);
  l.proc.onaudioprocess = null;
  l.proc.disconnect();
  l.source.disconnect();
  for (const track of l.stream.getTracks()) track.stop();
  await l.ctx.close().catch(() => {});
}

export async function start(): Promise<void> {
  if (live) return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    send({ type: "caret-listen-error", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    return;
  }

  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but needs no separate worklet module (which
  // the extension CSP makes awkward); at 4096 frames it runs ~12x a second.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  source.connect(proc);
  proc.connect(ctx.destination); // required for processing to run; outputs silence
  const ratio = ctx.sampleRate / TARGET_RATE;
  const beat = setInterval(() => send({ type: "caret-listen-heartbeat" }), 20_000);
  live = { stream, ctx, source, proc, beat };
  send({
    type: "caret-listen-status",
    state: ctx.state,
    sampleRate: ctx.sampleRate,
    device: stream.getAudioTracks()[0]?.label ?? "",
  });
  // The heartbeat above is what keeps the worker (and its pause timer) alive:
  // an idle service worker would be shut down before the pause ends.

  let noiseFloor = 0.005;
  let preRoll: Float32Array[] = [];
  let preRollMs = 0;
  let current: Float32Array[] | null = null;
  let durationMs = 0;
  let speechMs = 0;
  let silenceMs = 0;

  const finish = (): void => {
    const chunks = current!;
    current = null;
    if (speechMs < MIN_SPEECH_MS) return;
    const wav = encodeWav(chunks, TARGET_RATE);
    send({ type: "caret-utterance", wav: toBase64(wav), seconds: durationMs / 1000 });
  };

  proc.onaudioprocess = (e): void => {
    const input = e.inputBuffer.getChannelData(0);
    let sq = 0;
    for (let i = 0; i < input.length; i++) sq += input[i]! * input[i]!;
    const rms = Math.sqrt(sq / input.length);
    const ms = (input.length / ctx.sampleRate) * 1000;
    const chunk = downsample(input, ratio);
    const voiced = rms > Math.max(MIN_THRESHOLD, noiseFloor * 3);

    if (!current) {
      if (!voiced) noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      preRoll.push(chunk);
      preRollMs += ms;
      while (preRollMs > PRE_ROLL_MS && preRoll.length > 1) {
        preRoll.shift();
        preRollMs -= ms;
      }
      if (voiced) {
        current = preRoll;
        durationMs = preRollMs;
        speechMs = ms;
        silenceMs = 0;
        preRoll = [];
        preRollMs = 0;
      }
      return;
    }

    current.push(chunk);
    durationMs += ms;
    if (voiced) {
      speechMs += ms;
      silenceMs = 0;
    } else {
      silenceMs += ms;
    }
    if (silenceMs >= END_SILENCE_MS || durationMs >= MAX_UTTERANCE_MS) finish();
  };
}
