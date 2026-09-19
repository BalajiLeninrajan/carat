import { defineContentScript } from 'wxt/utils/define-content-script';
import { createChip } from '../src/chip';
import { createPageState, send, startActions, startCapture, startStatus } from '../src/content';
import { startFrameAgent } from '../src/frames';
import { startHistoryRecorder } from '../src/history';
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
    // The keyboard shortcut lands here from the background; the only message a content script receives.
    const stop = onMessage('forceSuggest', () => {
      if (ctx.isValid) suggestions.force();
    });
    ctx.onInvalidated(stop);
  },
});

function parentReachable(): boolean {
  try {
    return !!window.parent.document;
  } catch {
    return false;
  }
}
