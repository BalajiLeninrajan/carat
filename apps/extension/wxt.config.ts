import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Carat',
    description: "Cursor-style Tab for the browser, grounded in Chrome's accessibility tree.",
    // debugger: the engine reads every page through Accessibility.getFullAXTree and acts through CDP.
    // webNavigation: visits.ts logs every top-level navigation into the timeline.
    // search: the "open" kind runs a query with the user's own default engine.
    permissions: ['debugger', 'storage', 'tabs', 'webNavigation', 'search'],
    host_permissions: ['<all_urls>'],
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
