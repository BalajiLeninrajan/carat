import { defineContentScript } from 'wxt/utils/define-content-script';
import { createChip } from '../src/chip';
import { createPageState, send, startActions, startCapture, startStatus } from '../src/content';
import { startFrameAgent } from '../src/frames';
import { startHistoryRecorder } from '../src/history';
import { createStatusLine } from '../src/status';
import { onMessage } from '../src/messaging';

/**
 * The message the background sends after a clear. It is declared here rather
 * than in the protocol itself so the clear side owns that file; two identical
 * signatures merge as overloads, so both may declare it.
 */
declare module '../src/messaging' {
  interface Protocol {
    contextCleared(): void;
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  // Payment forms live in cross-origin frames (Stripe, Adyen); the script runs there too, as a frame agent.
  allFrames: true,
  runAt: 'document_idle',
  main(ctx) {
    if (window.self !== window.top) {
      // A same-origin child is read by its parent directly; a cross-origin one reports through the frame protocol.
      if (parentReachable()) return;
      startFrameAgent(ctx, document, {});
      return;
    }
    // Shared between the two schedulers: once a chip has shown here, no picture of this page.
    const page = createPageState();
    const status = startStatus(ctx, createStatusLine(document), document);
    const suggestions = startActions(ctx, createChip(document), document, {
      page,
      onRequest: () => status.setBusy(true),
      onAnswer: () => {
        status.setBusy(false);
        status.refresh();
      },
    });
    // The page's own text is what a navigation chip is built from, so a new capture re-asks.
    startCapture(ctx, document, { page, onCaptured: () => suggestions.refresh() });
    // What the user clicked and typed here, for the timeline the next request carries.
    startHistoryRecorder(ctx, document, { emit: (entry) => void send('history', { entries: [entry] }) });
    // The keyboard shortcut lands here from the background.
    const stopForce = onMessage('forceSuggest', () => {
      if (ctx.isValid) suggestions.force();
    });
    // Carat was told to forget: the chip, the memo and this page load's answers go with it.
    const stopCleared = onMessage('contextCleared', () => {
      if (ctx.isValid) suggestions.clear();
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
