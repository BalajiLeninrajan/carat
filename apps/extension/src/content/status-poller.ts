import type { StatusLine } from '../status';
import type { ScriptContext } from './context';
import { send } from './send';

export const STATUS_TIMING = {
  /** Settings can change on the options page at any time; a content script only learns by asking. */
  pollMs: 20_000,
} as const;

export interface StatusHandle {
  /** Ask the background again now: after a request, on becoming visible. */
  refresh(): void;
  setBusy(busy: boolean): void;
}

/**
 * Keeps the status line current. The background computes everything; the
 * content script never reads settings itself, so the key stays where it is.
 */
export function startStatus(ctx: ScriptContext, line: StatusLine, doc: Document = document): StatusHandle {
  let seq = 0;

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
  };
}
