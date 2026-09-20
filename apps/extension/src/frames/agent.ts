import type { AcceptKey, RelayedKey } from '../chip';
import type { ScriptContext } from '../content/context';
import { debounce } from '../content/context';
import { performFill } from '../fill';
import { performInteraction, roleOf, stillFits } from '../interact';
import type { OutlineTarget } from '../outline';
import { buildOutline } from '../outline';
import { documentHeight, MORE_SLACK_PX } from '../scroll';
import { parseOutline } from './lines';
import type { Box, FrameReport, PerformReply, PerformRequest, ToChild, ToTop } from './protocol';
import { FRAME_BUDGET, FRAME_MAX_LINES, isFrameMessage, stamp } from './protocol';

export const FRAME_TIMING = { initialMs: 800, debounceMs: 400 } as const;

export interface FrameAgentOptions {
  /** The window to report to; the real top window unless a test says otherwise. */
  top?: Window;
}

export interface FrameAgent {
  /** Enumerate now and report, whether or not anything changed. */
  report(): Promise<void>;
  stop(): void;
}

/**
 * The content script's job in a cross-origin child frame: describe itself to
 * the top frame, perform one fill or interaction there when asked, and while
 * the top has a chip up for one of its fields, take the chip's key here
 * (where the top cannot hear it) and relay it. A same-origin child frame
 * does none of this; its parent enumerates it directly.
 *
 * Describing itself means its whole outline and not a list of fields. The
 * child runs the same builder the top runs, gated by its own viewport, and
 * sends the lines. A comment box without the comments above it, or a booking
 * frame without its dates and its prices, is a form the model has to guess at.
 */
export function startFrameAgent(ctx: ScriptContext, doc: Document, opts: FrameAgentOptions): FrameAgent {
  const win = doc.defaultView!;
  const top = opts.top ?? win.top!;
  const token = Math.random().toString(36).slice(2, 10);
  let outline = new Map<number, OutlineTarget>();
  let lastKey = '';
  let armed: AcceptKey | null = null;
  let stopped = false;

  const post = (msg: ToTop): void => {
    if (stopped) return;
    try {
      top.postMessage(msg, '*');
    } catch {
      // The top window is gone or refuses; nothing to do from here.
    }
  };

  const box = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };

  /** Whether the frame scrolls on its own, which is what makes its own notes about the fold worth carrying. */
  const scrollsItself = (): boolean => documentHeight(win, doc) > win.innerHeight + MORE_SLACK_PX;

  async function report(reply = false): Promise<void> {
    if (stopped || !ctx.isValid) return;
    const o = buildOutline(doc, win, { budget: FRAME_BUDGET });
    outline = o.registry;
    const parsed = parseOutline(o.outline, FRAME_MAX_LINES);
    const host = doc.location?.host ?? '';
    const body: FrameReport = {
      controls: o.controls,
      lines: parsed.lines,
      ...(parsed.summary.length > 0 && scrollsItself() ? { summary: parsed.summary } : {}),
      ...(host ? { host } : {}),
      rects: {},
    };
    for (const [n, target] of outline) body.rects[String(n)] = box(target.el);
    const key = JSON.stringify([body.controls, body.lines, body.summary]);
    // An unasked-for report only when something changed; a reply always, so the top stops waiting.
    if (!reply && key === lastKey) return;
    lastKey = key;
    post(stamp({ type: 'report', token, reply, report: body }));
  }
  const reportSoon = debounce(ctx, () => void report(), FRAME_TIMING.debounceMs);

  async function perform(req: PerformRequest): Promise<PerformReply> {
    const target = outline.get(req.n)?.el;
    if (!target?.isConnected) return { ok: false };
    if (req.action === 'fill') {
      const outcome = await performFill(target, req.value, req.host ?? doc.location.host, req.locale ? { locale: req.locale } : {});
      return outcome ? { ok: true, outcome } : { ok: false };
    }
    const role = roleOf(target) ?? 'button';
    const verb = req.action === 'select' ? 'choose' : 'click';
    if (!stillFits(target, verb, role)) return { ok: false };
    return { ok: performInteraction(target, verb, req.value, role) };
  }

  const onMessage = (e: MessageEvent): void => {
    if (e.source !== top || !isFrameMessage(e.data)) return;
    const msg = e.data as ToChild;
    switch (msg.type) {
      case 'snapshot':
        void report(true);
        return;
      case 'perform':
        void perform(msg.req).then((reply) => post(stamp({ type: 'performed', token, seq: msg.seq, reply })));
        return;
      case 'arm':
        armed = msg.key;
        return;
      case 'disarm':
        armed = null;
        return;
    }
  };

  const relay = (key: RelayedKey): void => post(stamp({ type: 'key', token, key }));

  const onKeydown = (e: KeyboardEvent): void => {
    if (!armed || e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      relay('Escape');
      return;
    }
    if (e.key !== armed || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    relay(armed);
  };
  const onInput = (): void => {
    if (armed) relay('typed');
  };

  ctx.addEventListener(win, 'message', onMessage as EventListener);
  ctx.addEventListener(win, 'keydown', onKeydown as EventListener, true);
  ctx.addEventListener(doc, 'input', onInput, true);
  ctx.addEventListener(doc, 'focusin', reportSoon);
  ctx.addEventListener(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'visible') reportSoon();
  });
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(reportSoon) : null;
  observer?.observe(doc.documentElement, { childList: true, subtree: true });
  ctx.setTimeout(() => void report(), FRAME_TIMING.initialMs);
  ctx.onInvalidated(stop);

  function stop(): void {
    stopped = true;
    armed = null;
    observer?.disconnect();
  }

  return { report: () => report(true), stop };
}
