import { defineContentScript } from 'wxt/utils/define-content-script';
import { createChip } from '../src/chip';
import { createPageState, send, startCapture, startStatus, startSuggestions } from '../src/content';
import { startFrameAgent } from '../src/frames';
import { createStatusLine } from '../src/status';
import { onMessage } from '../src/messaging';

export default defineContentScript({
  matches: ['<all_urls>'],
  // Payment forms live in cross-origin frames (Stripe, Adyen); the script runs there too, as a frame agent.
  allFrames: true,
  runAt: 'document_idle',
  main(ctx) {
    if (window.self !== window.top) {
      // A same-origin child is read by its parent directly; a cross-origin one reports through the frame protocol.
      if (parentReachable()) return;
      startFrameAgent(ctx, document, {
        allowPayments: async () => (await send('getSettings', undefined))?.allowPayments === true,
      });
      return;
    }
    // Shared between the two schedulers: once a chip has shown here, no picture of this page.
    const page = createPageState();
    const status = startStatus(ctx, createStatusLine(document), document);
    const suggestions = startSuggestions(ctx, createChip(document), document, {
      page,
      onRequest: () => status.setBusy(true),
      onAnswer: () => {
        status.setBusy(false);
        status.refresh();
      },
    });
    // The page's own text is what a navigation chip is built from, so a new capture re-asks.
    startCapture(ctx, document, { page, onCaptured: () => suggestions.refresh() });
    // The two messages a content script receives, both from a background that the user just prodded.
    const stopForce = onMessage('forceSuggest', () => {
      if (ctx.isValid) suggestions.force();
    });
    // The store was wiped, from the pill, the popup or Alt+Shift+X: the chip
    // goes, and so does everything this page load remembered.
    const stopCleared = onMessage('contextCleared', () => {
      if (!ctx.isValid) return;
      suggestions.forget();
      status.refresh();
    });
    ctx.onInvalidated(() => {
      stopForce();
      stopCleared();
    });
  },
});

function parentReachable(): boolean {
  try {
    return !!window.parent.document;
  } catch {
    return false;
  }
}
