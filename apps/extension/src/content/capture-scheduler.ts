import { LIMITS, hashText, normalizeWhitespace, truncate } from '@carat/shared';
import { captureVisibleText, collectVisibleText, shouldCapture } from '../capture';
import type { ScriptContext } from './context';
import { debounce } from './context';
import { send } from './send';

export const CAPTURE_TIMING = {
  initialMs: 1500,
  selectionMs: 500,
  mutationMs: 5000,
  minSelectionChars: 3,
} as const;

export interface CaptureOptions {
  /** Runs after a page or selection capture is sent; the suggest scheduler re-asks with the new own text. */
  onCaptured?: () => void;
}

export function startCapture(ctx: ScriptContext, doc: Document = document, opts: CaptureOptions = {}): void {
  const win = doc.defaultView;
  if (!win) return;
  const captured = opts.onCaptured ?? (() => undefined);

  let lastBody = '';
  let lastPageHash = -1;
  let lastPageAt = 0;
  let lastSelectionHash = -1;
  let mutationTimer: number | null = null;

  // The 40-char minimum is measured on body text alone; the title/host header
  // could otherwise clear it on an empty page.
  const allowed = (): boolean => {
    lastBody = collectVisibleText(doc, win);
    return shouldCapture(doc, doc.location, lastBody);
  };

  const capturePage = (onlyIfChanged: boolean): void => {
    lastPageAt = Date.now();
    if (!allowed()) return;
    const text = captureVisibleText(doc, win);
    const hash = hashText(text);
    if (onlyIfChanged && hash === lastPageHash) return;
    lastPageHash = hash;
    void send('capture', { url: doc.location.href, title: doc.title, text, kind: 'page' }).then(captured);
  };

  const captureSelection = (): void => {
    const raw = normalizeWhitespace(doc.getSelection()?.toString() ?? '');
    if (raw.length < CAPTURE_TIMING.minSelectionChars) return;
    // Gate on the page, not the selection: a 3-char selection on an allowed page is fine.
    if (!(lastBody ? shouldCapture(doc, doc.location, lastBody) : allowed())) return;
    const text = truncate(raw, LIMITS.selectionTextChars);
    const hash = hashText(text);
    if (hash === lastSelectionHash) return;
    lastSelectionHash = hash;
    void send('capture', { url: doc.location.href, title: doc.title, text, kind: 'selection' }).then(captured);
  };
  const selectionSoon = debounce(ctx, captureSelection, CAPTURE_TIMING.selectionMs);

  ctx.setTimeout(() => capturePage(false), CAPTURE_TIMING.initialMs);
  ctx.addEventListener(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'hidden') capturePage(false);
  });
  ctx.addEventListener(doc, 'selectionchange', selectionSoon);
  ctx.addEventListener(doc, 'copy', captureSelection);

  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver(() => {
    if (mutationTimer !== null) return;
    const wait = Math.max(0, CAPTURE_TIMING.mutationMs - (Date.now() - lastPageAt));
    mutationTimer = ctx.setTimeout(() => {
      mutationTimer = null;
      capturePage(true);
    }, wait);
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
  ctx.onInvalidated(() => observer.disconnect());
}
