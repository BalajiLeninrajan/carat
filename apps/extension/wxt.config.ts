import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Carat',
    description: 'Fills a field, presses a control or opens the next tab from what you just read. One Tab each.',
    // webNavigation needs no host permission of its own; <all_urls> below already covers the URLs its events carry.
    // offscreen carries no warning of its own: it is the document the clipboard is read from.
    permissions: ['storage', 'alarms', 'tabs', 'webNavigation', 'offscreen'],
    // Never in `permissions`: reading the system clipboard is asked for from
    // the options page, on the gesture that turns the setting on, and given
    // back when it goes off.
    optional_permissions: ['clipboardRead'],
    host_permissions: ['<all_urls>', 'https://api.openai.com/*'],
    commands: {
      'carat-suggest': {
        suggested_key: { default: 'Alt+Shift+C' },
        description: 'Ask Carat for a suggestion on this page now',
      },
      clearContext: {
        suggested_key: { default: 'Alt+Shift+X' },
        description: 'Clear what Carat remembers',
      },
      toggleDebug: {
        suggested_key: { default: 'Alt+Shift+D' },
        description: 'Show what Carat is thinking on this page',
      },
    },
  },
});
