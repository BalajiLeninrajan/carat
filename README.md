# CARAT

Hack The North 2026 project

## What it does

Carat is a Chrome extension that remembers the text on the tabs you read and, when you land on a page with an empty field, offers to fill that field from what you just read. The offer is a small chip beside the field that says `Fill "Seven Shores Cafe"? Tab`; Tab fills it, Esc dismisses it, and nothing else happens. Carat never navigates, clicks, or fills more than the one field you accepted.

## The errand it was built around

A friend messages you on Discord: "dinner at Seven Shores Cafe, Friday at 6?" You open Google Maps and the search box is empty; Carat offers the cafe name, you press Tab, then Enter, and Maps shows the address. You open a new event in Google Calendar; Carat offers the title from the Discord message (Tab), then the address from the Maps panel for the location field (Tab). Three fields, three Tabs, no copying.

Context lives only in `chrome.storage.session` for 30 minutes and is never written to disk. Pages with a password field, `chrome://` pages, and a denylist of banking, login, and health hosts are never captured. Suggestions come from OpenAI's chat completions API called directly from the service worker, with a regex-based local provider as the offline fallback (it is enough for the Maps step). The API key stays in the service worker; content scripts never receive it.

## Running it

```
pnpm install
pnpm build
```

Then in Chrome open `chrome://extensions`, turn on developer mode, choose "Load unpacked", and pick `apps/extension/.output/chrome-mv3`. Open the extension's options page and paste an OpenAI key (or pick the `local` provider to run with no key and no network).

The chip's second line says where the value came from ("from discord.com · 2m ago"); hovering shows the provider's reason.

The popup shows what Carat currently knows and a few controls:

- An "On for <host>" switch for the tab it was opened over. Off means Carat neither reads that site nor offers chips on it. Hosts match exactly, so switching off `www.google.com` leaves `calendar.google.com` alone.
- Pin. While pinned nothing new is read and nothing expires, so a stray tab cannot change what Carat knows mid-demo. Clear also unpins.
- Two debug lines for the current tab: what happened to its last capture, and how its last suggestion request went (which check stopped it, or each provider attempt with latency and error, or a cache hit).

`Alt+Shift+C` asks for a suggestion on the current page right now, past the answer cache and past anything you dismissed with Esc. Change the key at `chrome://extensions/shortcuts`.

## Tests and eval

```
pnpm typecheck
pnpm test
pnpm eval --provider local
```

`pnpm eval` runs the nine fixtures in `packages/providers/eval/fixtures` against a provider and prints pass/fail with latency. Pass `--provider openai` with `OPENAI_API_KEY` set in the environment to run them against the model instead of the regex fallback.
