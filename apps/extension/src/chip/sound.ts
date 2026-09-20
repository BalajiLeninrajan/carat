/**
 * The chip's three notes, synthesized on the spot: two sine partials for an
 * accept, one low one for an Esc, a rising pair when an irreversible action
 * arms. No files, so nothing has to be web-accessible.
 *
 * The AudioContext is built on the first sound and never before. Every sound
 * carat makes follows a key the user pressed, which is the gesture Chrome
 * wants before audio may start; building one at page load would be both a
 * suspended context on every tab and an autoplay warning in the console.
 */

/** Overall loudness. Low enough to sit under a page's own audio, not over it. */
const GAIN = 0.08;

interface Tone {
  hz: number;
  /** Milliseconds after the sound starts. */
  at: number;
  ms: number;
  gain: number;
}

const ACCEPT: Tone[] = [
  { hz: 880, at: 0, ms: 70, gain: GAIN },
  { hz: 1320, at: 0, ms: 70, gain: GAIN * 0.55 },
];
const DISMISS: Tone[] = [{ hz: 440, at: 0, ms: 50, gain: GAIN * 0.6 }];
const ARM: Tone[] = [
  { hz: 660, at: 0, ms: 60, gain: GAIN * 0.8 },
  { hz: 990, at: 70, ms: 70, gain: GAIN * 0.8 },
];

export interface Sounds {
  /** The options page's "Sound on Tab". Off means no context is ever built. */
  setEnabled(on: boolean): void;
  accept(): void;
  dismiss(): void;
  arm(): void;
  close(): void;
}

type AudioCtor = new () => AudioContext;

export function createSounds(win: Window = window): Sounds {
  let enabled = true;
  let ctx: AudioContext | null = null;
  // One failure is enough: a context that would not build will not build later either.
  let broken = false;

  /**
   * The constructor is looked up per call rather than at module load, so a
   * page without Web Audio simply stays silent, and a test can decide when
   * the thing exists.
   */
  function ctor(): AudioCtor | null {
    const w = win as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
    return w.AudioContext ?? w.webkitAudioContext ?? null;
  }

  /** The context, built on this first sound if it does not exist yet. */
  function open(): AudioContext | null {
    if (!enabled || broken) return null;
    if (!ctx) {
      const Ctor = ctor();
      if (!Ctor) return null;
      try {
        ctx = new Ctor();
      } catch {
        broken = true;
        return null;
      }
    }
    // A context built on an earlier tab suspends when the tab is backgrounded;
    // the Tab press this is running under is the gesture that may resume it.
    if (ctx.state === 'suspended') void ctx.resume?.().catch(() => undefined);
    return ctx;
  }

  function play(parts: Tone[]): void {
    const audio = open();
    if (!audio) return;
    try {
      const t0 = audio.currentTime;
      for (const p of parts) {
        const start = t0 + p.at / 1000;
        const end = start + p.ms / 1000;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(p.hz, start);
        // A quick exponential decay, so it reads as a tap rather than a beep.
        gain.gain.setValueAtTime(p.gain, start);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(start);
        osc.stop(end);
      }
    } catch {
      // A context the browser tore down under us is not worth a broken chip.
    }
  }

  return {
    setEnabled(on) {
      enabled = on;
    },
    accept: () => play(ACCEPT),
    dismiss: () => play(DISMISS),
    arm: () => play(ARM),
    close() {
      const audio = ctx;
      ctx = null;
      try {
        void audio?.close?.();
      } catch {
        // Already gone.
      }
    },
  };
}
