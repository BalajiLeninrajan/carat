import type { AcceptKey, RelayedKey } from '../chip';
import type { ScriptContext } from '../content/context';
import { debounce } from '../content/context';
import { performFill } from '../fill';
import type { ElementEntry } from '../interact';
import { enumerateElements, performInteraction, stillFits } from '../interact';
import type { FieldEntry } from '../snapshot';
import { enumerateFields, valueOf } from '../snapshot';
import type { Box, FrameReport, PerformReply, PerformRequest, ToChild, ToTop } from './protocol';
import { isFrameMessage, stamp } from './protocol';

export const FRAME_TIMING = { initialMs: 800, debounceMs: 400 } as const;

export interface FrameAgentOptions {
  /** Whether money controls may be described; asked before each report. */
  allowPayments: () => Promise<boolean>;
  /** The window to report to; the real top window unless a test says otherwise. */
  top?: Window;
}

export interface FrameAgent {
  /** Enumerate now and report, whether or not anything changed. */
  report(): Promise<void>;
  stop(): void;
}

/**
 * The content script's job in a cross-origin child frame: describe its
 * fields and elements to the top frame, perform one fill or interaction
 * there when asked, and while the top has a chip up for one of them, take
 * the chip's key here (where the top cannot hear it) and relay it. A
 * same-origin child frame does none of this; its parent enumerates it
 * directly.
 */
export function startFrameAgent(ctx: ScriptContext, doc: Document, opts: FrameAgentOptions): FrameAgent {
  const win = doc.defaultView!;
  const top = opts.top ?? win.top!;
  const token = Math.random().toString(36).slice(2, 10);
  let fields = new Map<string, FieldEntry>();
  let elements = new Map<string, ElementEntry>();
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

  async function report(reply = false): Promise<void> {
    if (stopped || !ctx.isValid) return;
    const allowPayments = await opts.allowPayments();
    const f = enumerateFields(doc, win, { frame: true });
    const e = enumerateElements(doc, win, { frame: true, allowPayments });
    fields = f.registry;
    elements = e.registry;
    const body: FrameReport = { fields: f.descriptors, elements: e.descriptors, rects: {}, fingerprints: {}, entries: {} };
    for (const [id, entry] of fields) {
      body.rects[id] = box(entry.el);
      body.fingerprints[id] = entry.fingerprint;
    }
    for (const [id, entry] of elements) {
      body.rects[id] = box(entry.el);
      body.entries[id] = { role: entry.role, name: entry.name, ...(entry.money ? { money: true } : {}) };
    }
    const key = JSON.stringify([body.fields, body.elements]);
    // An unasked-for report only when something changed; a reply always, so the top stops waiting.
    if (!reply && key === lastKey) return;
    lastKey = key;
    post(stamp({ type: 'report', token, reply, report: body }));
  }
  const reportSoon = debounce(ctx, () => void report(), FRAME_TIMING.debounceMs);

  async function perform(req: PerformRequest): Promise<PerformReply> {
    if (req.kind === 'fill') {
      const entry = fields.get(req.id);
      if (!entry || !entry.el.isConnected || valueOf(entry.el)) return { ok: false };
      const outcome = await performFill(entry.el, req.value, req.host, req.locale ? { locale: req.locale } : {});
      return outcome ? { ok: true, outcome } : { ok: false };
    }
    const entry = elements.get(req.id);
    if (!entry || !stillFits(entry.el, req.verb, entry.role)) return { ok: false };
    return { ok: performInteraction(entry.el, req.verb, req.value, entry.role) };
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
