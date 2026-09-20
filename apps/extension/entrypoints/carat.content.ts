import { defineContentScript } from 'wxt/utils/define-content-script';
import { createChip } from '../src/chip';
import { createPageState, send, startActions, startCapture, startStatus } from '../src/content';
import { startDebug } from '../src/debug';
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
    const chip = createChip(document);
    // The chip's one setting a page is allowed to know about; the status poll
    // is how it learns, so turning the sound off reaches an open tab.
    const status = startStatus(ctx, createStatusLine(document), document, {
      onInfo: (info) => chip.setSound(info.sound),
    });
    // Alt+Shift+D. Nothing is collected on either side until it has been opened once here.
    const debug = startDebug(ctx, document);
    const suggestions = startActions(ctx, chip, document, {
      page,
      onRequest: () => status.setBusy(true),
      onAnswer: () => {
        status.setBusy(false);
        status.refresh();
      },
      // Shift+Tab: the pill counts the quiet minute down instead of naming the model.
      onQuiet: (until) => {
        status.setQuiet(until);
        debug.setQuiet(until);
      },
      onEvent: (event) => debug.event(event),
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
