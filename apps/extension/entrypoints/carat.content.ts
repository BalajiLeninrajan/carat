import { defineContentScript } from 'wxt/utils/define-content-script';
import { createChip } from '../src/chip';
import { startCapture, startSuggestions } from '../src/content';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    // One page item per tab: a frame's text must not replace the top document's.
    if (window.self !== window.top) return;
    startCapture(ctx, document);
    startSuggestions(ctx, createChip(document), document);
  },
});
