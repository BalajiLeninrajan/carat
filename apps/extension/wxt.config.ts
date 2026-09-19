import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Carat',
    description: 'Fills a field, presses a control or opens the next tab from what you just read. One Tab each.',
    permissions: ['storage', 'alarms', 'tabs'],
    host_permissions: ['<all_urls>', 'https://api.openai.com/*'],
    commands: {
      'carat-suggest': {
        suggested_key: { default: 'Alt+Shift+C' },
        description: 'Ask Carat for a suggestion on this page now',
      },
    },
  },
});
