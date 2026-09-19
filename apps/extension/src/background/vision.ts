import type { ImageCue, Settings } from '@carat/shared';
import { LIMITS, isDenylisted } from '@carat/shared';
import type { VisionProvider } from '@carat/providers';
import { createSmartProvider } from '@carat/providers';
import type { ContextStore, ShotStore } from '../store';
import { isSiteOff, parseLocation } from '../store';
import type { VisionDiag, VisionVerdict } from './diag';
import { downscale } from './downscale';
import type { Requester } from './requester';

/**
 * What a content script tells the background about a tab worth seeing.
 * `shot`: the page in front is thin, take a picture now. `leaving`: the tab
 * is being hidden, read the picture. `filling`: a chip is up on this page,
 * so it is the page being filled and must not be in any picture.
 */
export interface VisionCue {
  action: 'shot' | 'leaving' | 'filling';
  url: string;
  title: string;
  bodyChars: number;
}

/** The slice of chrome.tabs the pipeline needs: is the tab in front, and a picture of its window. */
export interface ScreenApi {
  get(tabId: number): Promise<{ active: boolean; windowId: number } | undefined>;
  captureVisible(windowId: number): Promise<string>;
}

export interface VisionDeps {
  store: ContextStore;
  shots: ShotStore;
  settings: () => Promise<Settings>;
  tabs: ScreenApi;
  createSmartProvider?: (settings: Settings) => Pick<VisionProvider, 'transcribe'> | undefined;
  downscale?: (dataUrl: string) => Promise<string>;
  timeoutMs?: number;
  /** Told what became of each cue, for the popup's debug line. */
  onDiag?: (tabId: number, diag: VisionDiag) => void;
}

export interface VisionPipeline {
  handle(cue: VisionCue, tabId: number): Promise<void>;
  /** True while a screenshot from some tab other than the requester's is still being read. */
  hasPending(requester: Requester): boolean;
  /** Resolves once every transcription in flight right now has landed or failed. */
  settled(): Promise<void>;
}

const MIN_TRANSCRIPT_CHARS = 40;

/**
 * Screenshot while the tab is in front, read it once the user leaves.
 * captureVisibleTab only sees the tab that is showing, so a picture taken on
 * visibilitychange would be of whatever came next, often the page being
 * filled. Reading is deferred to the leave so a page the user only glanced
 * at costs a picture in session storage, not a model call.
 */
export function createVisionPipeline(deps: VisionDeps): VisionPipeline {
  const inflight = new Map<number, Promise<void>>();
  const timeoutMs = deps.timeoutMs ?? LIMITS.transcribeTimeoutMs;
  const shrink = deps.downscale ?? ((dataUrl: string) => downscale(dataUrl));
  const smart = deps.createSmartProvider ?? createSmartProvider;

  async function handle(cue: VisionCue, tabId: number): Promise<void> {
    const host = hostOf(cue.url);
    const note = (verdict: VisionVerdict): void => deps.onDiag?.(tabId, { at: Date.now(), host, verdict });
    if (cue.action === 'filling') {
      await deps.shots.remove(tabId);
      return note('dropped');
    }
    const settings = await deps.settings();
    if (!settings.enabled) return note('disabled');
    if (!settings.screenshots) return note('screenshots-off');
    const location = parseLocation(cue.url);
    if (!location) return note('not-http');
    if (isDenylisted(new URL(location.origin).hostname)) return note('denylisted');
    if (isSiteOff(settings, host)) return note('site-off');
    // Pinned means nothing new is read: no point holding a picture that could never become an item.
    if (await deps.store.isPinned()) return note('pinned');
    if (cue.action === 'shot') return note(await screenshot(cue, tabId));
    startReading(tabId, settings, note);
  }

  async function screenshot(cue: VisionCue, tabId: number): Promise<VisionVerdict> {
    const tab = await deps.tabs.get(tabId);
    if (!tab?.active) return 'not-in-front';
    let dataUrl: string;
    try {
      dataUrl = await deps.tabs.captureVisible(tab.windowId);
    } catch {
      return 'capture-failed'; // quota, a chrome:// page in front, or a closed window
    }
    // A switch during the capture means the picture shows some other tab.
    const after = await deps.tabs.get(tabId);
    if (!after?.active || after.windowId !== tab.windowId) return 'not-in-front';
    await deps.shots.put({ tabId, url: cue.url, title: cue.title, dataUrl: await shrink(dataUrl), cue: cueKind(cue) });
    return 'shot';
  }

  function startReading(tabId: number, settings: Settings, note: (v: VisionVerdict) => void): void {
    if (inflight.has(tabId)) return;
    const job = read(tabId, settings, note)
      .catch(() => note('failed'))
      .finally(() => inflight.delete(tabId));
    inflight.set(tabId, job);
  }

  async function read(tabId: number, settings: Settings, note: (v: VisionVerdict) => void): Promise<void> {
    const shot = await deps.shots.take(tabId);
    if (!shot) return note('no-shot');
    const provider = smart(settings);
    if (!provider) return note('no-model');
    note('reading');
    const host = new URL(shot.url).host;
    // The picture's own time, not the leave: "3 days ago" in it counts from when it was taken.
    const text = await provider.transcribe(
      { dataUrl: shot.dataUrl, title: shot.title, host, now: isoWithOffset(shot.capturedAt), cue: shot.cue },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (text.length < MIN_TRANSCRIPT_CHARS) return note('short');
    const header = [shot.title, host].filter(Boolean).join(' · ');
    const item = await deps.store.upsertVision({ tabId, url: shot.url, title: shot.title, text: `${header}\n${text}` });
    note(item ? 'transcribed' : 'pinned');
  }

  return {
    handle,
    hasPending: (requester) => [...inflight.keys()].some((id) => id !== requester.tabId),
    settled: () => Promise.all(inflight.values()).then(() => undefined),
  };
}

/**
 * The content script only cues a shot for a thin page. Under the text floor
 * it is thin for want of text; at or over it, only a large image or canvas in
 * view got it here, and that image is what the model needs to look at.
 */
function cueKind(cue: VisionCue): ImageCue {
  return cue.bodyChars < LIMITS.thinTextChars ? 'thin-text' : 'image-heavy';
}

/** Local time as ISO 8601 with the zone offset, the form the prompts promise the model. */
export function isoWithOffset(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
