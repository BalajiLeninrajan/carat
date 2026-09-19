import type { AcceptKey, RelayedKey } from '../chip';
import { anchorInFrame } from '../chip/position';
import type { ScriptContext } from '../content/context';
import type { FrameReport, PerformReply, PerformRequest, ToChild, ToTop } from './protocol';
import { frameNumber, isFrameMessage, stamp } from './protocol';

/** How long the top waits for child frames to answer a snapshot request, and for one to perform. */
export const HUB_TIMING = { refreshMs: 150, performMs: 3000, staleMs: 60_000 } as const;
/** Frames are searched this many levels down for the window a report came from. */
const FRAME_DEPTH = 3;

export interface KnownFrame {
  token: string;
  source: Window;
  /** The frame element in the top document that holds the window (or its nearest ancestor frame, for a nested one). */
  iframe: Element;
  report: FrameReport;
  at: number;
}

export interface FrameHubOptions {
  /** A frame sent a fresh, unasked-for report: worth a new snapshot. */
  onReport: () => void;
  /** The armed frame heard a key while the chip was up for one of its fields. */
  onKey: (key: RelayedKey) => void;
  now?: () => number;
}

export interface FrameHub {
  /** Every frame heard from lately, whose element is still on the page. */
  frames(): KnownFrame[];
  /** Ask every known frame to report again; resolves when all have, or after the wait. */
  refresh(waitMs?: number): Promise<void>;
  perform(frame: KnownFrame, req: PerformRequest, timeoutMs?: number): Promise<PerformReply>;
  /** Tell one frame to take this key and relay it while the chip is up for one of its fields. */
  arm(frame: KnownFrame, key: AcceptKey): void;
  disarm(): void;
  /** Where a frame's field sits in the top viewport, or null when it is outside its frame's view. */
  anchor(frame: KnownFrame, id: string): DOMRect | null;
  /** The frame's number for `fr`, by its position among the top document's frames. */
  numberOf(frame: KnownFrame): number;
  destroy(): void;
}

/**
 * The top frame's side of the frame protocol. It keeps the last report from
 * each child frame it has heard from, matched to the frame element that
 * holds it, so the scheduler can merge those descriptors with its own,
 * anchor a chip over a field it cannot reach, and have the child perform.
 * Reports are data from another document: nothing in them is trusted as an
 * instruction, and a report from a window that is not inside this page is
 * dropped.
 */
export function createFrameHub(ctx: ScriptContext, doc: Document, opts: FrameHubOptions): FrameHub {
  const win = doc.defaultView!;
  const now = opts.now ?? (() => Date.now());
  const known = new Map<string, KnownFrame>();
  const pendingPerform = new Map<number, (reply: PerformReply) => void>();
  let awaitingReports: { tokens: Set<string>; done: () => void } | null = null;
  let armed: KnownFrame | null = null;
  let seq = 0;

  const send = (frame: KnownFrame, msg: ToChild): void => {
    try {
      frame.source.postMessage(msg, '*');
    } catch {
      // The frame navigated away or was removed; its next report re-registers it.
    }
  };

  const onMessage = (e: MessageEvent): void => {
    if (!isFrameMessage(e.data) || !e.source || typeof (e.source as Window).postMessage !== 'function') return;
    const msg = e.data as ToTop;
    const source = e.source as Window;
    if (msg.type === 'report') {
      if (!validReport(msg.report)) return;
      const iframe = findIframeFor(doc, source);
      if (!iframe) return;
      known.set(msg.token, { token: msg.token, source, iframe, report: msg.report, at: now() });
      if (awaitingReports) {
        awaitingReports.tokens.delete(msg.token);
        if (awaitingReports.tokens.size === 0) awaitingReports.done();
      }
      if (!msg.reply) opts.onReport();
      return;
    }
    const frame = known.get(msg.token);
    if (!frame || frame.source !== source) return;
    if (msg.type === 'performed') {
      pendingPerform.get(msg.seq)?.(msg.reply);
      pendingPerform.delete(msg.seq);
      return;
    }
    if (msg.type === 'key' && armed === frame) opts.onKey(msg.key);
  };
  ctx.addEventListener(win, 'message', onMessage as EventListener);

  function frames(): KnownFrame[] {
    const cutoff = now() - HUB_TIMING.staleMs;
    for (const [token, frame] of known) {
      if (!frame.iframe.isConnected || frame.at < cutoff) known.delete(token);
    }
    return [...known.values()];
  }

  function refresh(waitMs: number = HUB_TIMING.refreshMs): Promise<void> {
    const live = frames();
    if (live.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = win.setTimeout(finish, waitMs);
      awaitingReports = { tokens: new Set(live.map((f) => f.token)), done: finish };
      for (const frame of live) send(frame, stamp({ type: 'snapshot' }));
      function finish(): void {
        win.clearTimeout(timer);
        awaitingReports = null;
        resolve();
      }
    });
  }

  function perform(frame: KnownFrame, req: PerformRequest, timeoutMs: number = HUB_TIMING.performMs): Promise<PerformReply> {
    const mine = ++seq;
    return new Promise((resolve) => {
      const timer = win.setTimeout(() => {
        pendingPerform.delete(mine);
        resolve({ ok: false });
      }, timeoutMs);
      pendingPerform.set(mine, (reply) => {
        win.clearTimeout(timer);
        resolve(reply);
      });
      send(frame, stamp({ type: 'perform', seq: mine, req }));
    });
  }

  function arm(frame: KnownFrame, key: AcceptKey): void {
    disarm();
    armed = frame;
    send(frame, stamp({ type: 'arm', key }));
  }

  function disarm(): void {
    if (!armed) return;
    send(armed, stamp({ type: 'disarm' }));
    armed = null;
  }

  function anchor(frame: KnownFrame, id: string): DOMRect | null {
    const inner = frame.report.rects[id];
    if (!inner || !frame.iframe.isConnected) return null;
    const rect = anchorInFrame(frame.iframe.getBoundingClientRect(), inner);
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  return {
    frames,
    refresh,
    perform,
    arm,
    disarm,
    anchor,
    numberOf: (frame) => frameNumber(doc, frame.iframe),
    destroy() {
      disarm();
      known.clear();
    },
  };
}

/**
 * The frame element in `doc` holding `source`, searching child windows a few
 * levels down (a window's `frames` is readable across origins even though
 * its document is not). A nested frame maps to the top-level frame it sits
 * in, which is the best box the top can offer for it.
 */
export function findIframeFor(doc: Document, source: Window): Element | null {
  for (const el of doc.querySelectorAll('iframe,frame')) {
    const w = (el as HTMLIFrameElement).contentWindow;
    if (w && (w === source || contains(w, source, FRAME_DEPTH - 1))) return el;
  }
  return null;
}

function contains(win: Window, source: Window, depth: number): boolean {
  if (depth <= 0) return false;
  try {
    for (let i = 0; i < win.frames.length; i++) {
      const child = win.frames[i]!;
      if (child === source || contains(child, source, depth - 1)) return true;
    }
  } catch {
    // frames is unreadable here; treat as not containing
  }
  return false;
}

function validReport(r: unknown): r is FrameReport {
  if (!r || typeof r !== 'object') return false;
  const o = r as Partial<FrameReport>;
  return Array.isArray(o.fields) && Array.isArray(o.elements) && !!o.rects && !!o.fingerprints && !!o.entries;
}
