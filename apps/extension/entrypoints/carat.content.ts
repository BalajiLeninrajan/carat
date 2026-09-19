import { defineContentScript } from 'wxt/utils/define-content-script';
import { createChip } from '../src/chip';
import { createPageState, startCapture, startStatus, startSuggestions } from '../src/content';
import { createStatusLine } from '../src/status';
import { onMessage } from '../src/messaging';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    // One page item per tab: a frame's text must not replace the top document's.
    if (window.self !== window.top) return;
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
    // The keyboard shortcut lands here from the background; the only message a content script receives.
    const stop = onMessage('forceSuggest', () => {
      if (ctx.isValid) suggestions.force();
    });
    ctx.onInvalidated(stop);
  },
});
