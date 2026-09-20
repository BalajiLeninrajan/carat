import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Carat',
    description: "Cursor-style Tab for the browser, grounded in Chrome's accessibility tree.",
    // debugger: the engine reads every page through Accessibility.getFullAXTree and acts through CDP.
    // webNavigation: visits.ts logs every top-level navigation into the timeline.
    // search: the "open" kind runs a query with the user's own default engine.
    // offscreen carries no warning of its own: it is the document the clipboard is read from.
    // alarms: the Elastic sweep expires open tasks off the prediction path, and
    // a service worker is suspended too often for setInterval to be the timer.
    permissions: ['debugger', 'storage', 'tabs', 'webNavigation', 'search', 'offscreen', 'alarms'],
    // Never in `permissions`: reading the system clipboard is asked for from the
    // options page, on the gesture that turns the setting on, and given back
    // when it goes off.
    optional_permissions: ['clipboardRead'],
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
