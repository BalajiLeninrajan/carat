import type { ContentScriptContext } from 'wxt/utils/content-script-context';

/**
 * The slice of WXT's ContentScriptContext the content modules use. Timers and
 * listeners registered through it die when the extension reloads under a
 * still-open tab, which is what keeps an orphaned script from posting.
 */
export type ScriptContext = Pick<
  ContentScriptContext,
  'setTimeout' | 'addEventListener' | 'onInvalidated' | 'isValid'
>;

export function debounce(ctx: ScriptContext, fn: () => void, ms: number): () => void {
  let timer: number | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = ctx.setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}
