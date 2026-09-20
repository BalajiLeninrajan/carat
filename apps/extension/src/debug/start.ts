import type { DebugEvent, DebugSnapshot } from '../background/debug';
import type { ScriptContext } from '../content/context';
import { send } from '../content/send';
import { onMessage } from '../messaging';
import type { DebugPanel } from './panel';
import { createDebugPanel } from './panel';
import { debugView } from './view';

/** Scheduler events the page keeps for itself, once the panel has been opened here. */
export const PAGE_EVENTS = 50;

/** How long the panel waits for the next push before it repaints. */
export const REPAINT_MS = 200;

export interface DebugHandle {
  /** `Alt+Shift+D`, both ways. */
  toggle(): void;
  /** The scheduler's own events. Dropped on the floor until the panel has been opened on this tab. */
  event(event: { name: string; detail?: string }): void;
  /** Shift+Tab's minute, for the gate's `snoozed until` row. */
  setQuiet(until: number | null): void;
  readonly panel: DebugPanel;
}

export interface DebugOptions {
  panel?: DebugPanel;
  now?: () => number;
  /** Where "copy request" puts the text. Defaults to the clipboard. */
  copy?: (text: string) => void;
}

/**
 * The debug panel's side of the page. Off until `Alt+Shift+D`: before that
 * the background keeps nothing but its ordinary diag line and this keeps no
 * events at all. Opening tells the background to start collecting, asks for
 * everything it already has, and then repaints on each `debugEvent` push
 * until the panel closes again.
 */
export function startDebug(ctx: ScriptContext, doc: Document = document, opts: DebugOptions = {}): DebugHandle {
  const now = opts.now ?? (() => Date.now());
  const panel = opts.panel ?? createDebugPanel(doc, { onClose: () => void shut(), onCopy: (text) => copy(text) });
  /** The scheduler's events, newest last, and only while the panel is open. */
  let events: DebugEvent[] = [];
  let snapshot: DebugSnapshot | null = null;
  let quietUntil: number | null = null;
  let repaint: number | null = null;

  const copy = opts.copy ?? ((text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined));

  function paint(): void {
    if (!panel.visible || !snapshot) return;
    panel.render(debugView(snapshot, { events, hidden: doc.visibilityState === 'hidden', snoozedUntil: quietUntil, now: now() }));
  }

  /** Several pushes in a row are one repaint; the log would otherwise jump under the reader. */
  function soon(): void {
    if (repaint !== null || !panel.visible) return;
    repaint = ctx.setTimeout(() => {
      repaint = null;
      paint();
    }, REPAINT_MS);
  }

  async function pull(): Promise<void> {
    const next = await send('getDebug', {});
    if (!next || !panel.visible) return;
    snapshot = next;
    paint();
  }

  async function open(): Promise<void> {
    panel.open();
    await send('setDebug', { on: true });
    await pull();
  }

  async function shut(): Promise<void> {
    panel.close();
    events = [];
    snapshot = null;
    await send('setDebug', { on: false });
  }

  const stopToggle = onMessage('toggleDebug', () => {
    if (!ctx.isValid) return;
    if (panel.visible) void shut();
    else void open();
  });

  const stopPush = onMessage('debugEvent', ({ data }) => {
    if (!ctx.isValid || !panel.visible) return;
    snapshot = data;
    soon();
  });

  ctx.onInvalidated(() => {
    stopToggle();
    stopPush();
    panel.destroy();
  });

  return {
    toggle() {
      if (panel.visible) void shut();
      else void open();
    },
    event(event) {
      if (!panel.visible) return;
      const next: DebugEvent = { at: now(), source: 'page', name: event.name, ...(event.detail ? { detail: event.detail } : {}) };
      events = [...events, next].slice(-PAGE_EVENTS);
      soon();
    },
    setQuiet(until) {
      quietUntil = until;
      soon();
    },
    panel,
  };
}
