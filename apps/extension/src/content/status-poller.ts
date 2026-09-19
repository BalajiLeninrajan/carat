import type { StatusLine } from '../status';
import type { ScriptContext } from './context';
import { send } from './send';

export const STATUS_TIMING = {
  /** Settings can change on the options page at any time; a content script only learns by asking. */
  pollMs: 20_000,
  /** The snooze countdown on the pill moves a second at a time. */
  quietTickMs: 1000,
} as const;

export interface StatusHandle {
  /** Ask the background again now: after a request, on becoming visible. */
  refresh(): void;
  setBusy(busy: boolean): void;
  /** Carat went quiet until this moment, or null when it may speak again. */
  setQuiet(until: number | null): void;
}

/**
 * Keeps the status line current. The background computes everything; the
 * content script never reads settings itself, so the key stays where it is.
 */
export function startStatus(ctx: ScriptContext, line: StatusLine, doc: Document = document): StatusHandle {
  let seq = 0;
  let quietUntil: number | null = null;
  let quietTimer: number | null = null;

  /** The pill counts the snooze down; when it reaches zero the line goes back to naming the model. */
  function countdown(): void {
    if (quietUntil === null) return;
    const left = quietUntil - Date.now();
    if (left <= 0) {
      setQuiet(null);
      return;
    }
    line.setQuiet(left);
    quietTimer = ctx.setTimeout(countdown, STATUS_TIMING.quietTickMs);
  }

  function setQuiet(until: number | null): void {
    quietUntil = until;
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = null;
    if (until === null) {
      line.setQuiet(null);
      return;
    }
    countdown();
  }

  const refresh = async (): Promise<void> => {
    if (!ctx.isValid || doc.visibilityState === 'hidden') return;
    const mine = ++seq;
    const info = await send('getStatus', undefined);
    if (mine !== seq || !ctx.isValid || !info) return;
    line.update(info);
  };

  const tick = (): void => {
    void refresh();
    ctx.setTimeout(tick, STATUS_TIMING.pollMs);
  };
  tick();

  ctx.addEventListener(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'visible') void refresh();
  });
  ctx.onInvalidated(() => line.destroy());

  return {
    refresh: () => void refresh(),
    setBusy: (busy) => line.setBusy(busy),
    setQuiet,
  };
}
