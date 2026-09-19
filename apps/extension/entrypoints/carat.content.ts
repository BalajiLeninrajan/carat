import { defineContentScript } from 'wxt/utils/define-content-script';
import { createChip } from '../src/chip';
import { startCapture, startSuggestions } from '../src/content';
import { onMessage } from '../src/messaging';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    // One page item per tab: a frame's text must not replace the top document's.
    if (window.self !== window.top) return;
    startCapture(ctx, document);
    const suggestions = startSuggestions(ctx, createChip(document), document);
    // The keyboard shortcut lands here from the background; the only message a content script receives.
    const stop = onMessage('forceSuggest', () => {
      if (ctx.isValid) suggestions.refresh();
    });
    ctx.onInvalidated(stop);
  },
});
