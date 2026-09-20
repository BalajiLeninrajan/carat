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
    // offscreen: a service worker can reach neither the clipboard nor the
    // microphone, and one document (the only one Chrome allows) serves both.
    permissions: ['debugger', 'storage', 'tabs', 'webNavigation', 'search', 'offscreen', 'alarms'],
    // Never in required `permissions`: reading the system clipboard is asked
    // for from the options page, on the gesture that turns the setting on, and
    // given back when it goes off. Microphone access is a web media permission,
    // not a chrome.permissions optional permission, so it is prompted by
    // getUserMedia from the options tab.
    optional_permissions: ['clipboardRead'] as chrome.runtime.ManifestOptionalPermission[],
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
      // The content script hears Ctrl+Shift+K itself; this is the way in on a
      // page that has not loaded one, and the line Chrome's shortcut list shows.
      'open-palette': {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Ask Carat to do something on this page',
      },
    },
  },
});
