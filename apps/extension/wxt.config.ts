import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Carat',
    description: 'Fills a field from what you just read. One Tab per field.',
    permissions: ['storage', 'alarms', 'tabs'],
    host_permissions: ['<all_urls>', 'https://api.openai.com/*'],
  },
});
