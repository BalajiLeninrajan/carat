import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Carat',
    description: 'Fills a field, presses a control or opens the next tab from what you just read. One Tab each.',
    // webNavigation needs no host permission of its own; <all_urls> below already covers the URLs its events carry.
    permissions: ['storage', 'alarms', 'tabs', 'webNavigation'],
    host_permissions: ['<all_urls>', 'https://api.openai.com/*', 'https://api.cloudflare.com/*'],
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
