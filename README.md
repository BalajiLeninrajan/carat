# CARAT

Hack The North 2026 project

## What it does

Carat is a Chrome extension that remembers the text on the tabs you read and, when you land on a page with an empty field, offers to fill that field from what you just read. The offer is a small chip beside the field that says `Fill "Seven Shores Cafe"? Tab`; Tab fills it, Esc dismisses it, and nothing else happens.

When the page you are reading names a place, a plan with a time, or someone to email, and there is no field on it worth filling, Carat instead offers the next tab: a banner centred at the bottom of the page that says `Open in Google Maps: "Seven Shores Cafe"? Tab`. Tab opens that tab (or switches to it, if you already have Maps open) with the search, event or recipient prefilled through the URL. Esc dismisses it. Carat never navigates on its own; a tab only opens or changes after a Tab press on a visible chip. It never clicks, and it never fills more than the one field you accepted.

## The errand it was built around

A friend messages you on Discord: "dinner at Seven Shores Cafe, Friday at 6?" A chip appears on the Discord page offering to open the cafe in Google Maps; you press Tab and Maps opens with the search done. Back on Discord the next chip offers to add "Dinner at Seven Shores Cafe" to Google Calendar for Friday at 6; Tab opens the event form with the title, time and location set. If you open a new Calendar event by hand instead, Carat offers the title from the Discord message (Tab), then the address from the Maps panel for the location field (Tab). Either way, no copying.

Context lives only in `chrome.storage.session` for 30 minutes and is never written to disk. Pages with a password field, `chrome://` pages, and a denylist of banking, login, and health hosts are never captured. Suggestions come from OpenAI's chat completions API called directly from the service worker, with a regex-based local provider as the offline fallback (it is enough for the Maps step and the Discord chip). The API key stays in the service worker; content scripts never receive it.

## Where the two kinds of suggestion come from

Field fills only use text from other tabs; the page being filled is never its own source. Navigation offers only use text from the page you are on. The model (or the regex provider) extracts the entity, and a small registry in `packages/shared/src/intents.ts` builds the URL. Neither the model nor the content script ever supplies a URL; the service worker rebuilds it from the intent when the chip is accepted.

| Intent     | Trigger in the text          | Destination                                              |
| ---------- | ---------------------------- | -------------------------------------------------------- |
| `maps`     | a place name                 | Google Maps search for the place                         |
| `calendar` | a place and a time           | Google Calendar create-event with title, dates, location |
| `gmail`    | a request to email someone   | Gmail compose with the recipient                         |

If a tab already shows the destination, the chip says "Switch to" instead of "Open in" and reuses that tab.

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

`pnpm eval` runs the thirteen fixtures in `packages/providers/eval/fixtures` against a provider and prints pass/fail with latency. Pass `--provider openai` with `OPENAI_API_KEY` set in the environment to run them against the model instead of the regex fallback.
