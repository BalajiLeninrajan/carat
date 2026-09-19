# CARAT

Hack The North 2026 project

## What it does

Carat is a Chrome extension that predicts the one thing you are most likely to do next on the page you are on, and offers it as a small chip you accept with Tab. On a results page for "doordash" the chip is `Click "DoorDash Food Delivery"? Tab`. Halfway down an article it is `Scroll down? Tab`. On a checkout with nothing left to type it is `Click "Continue to payment"? Tab`. On a page with an empty field and something you just read that fits it, it is `Fill "Seven Shores Cafe"? Tab`. One chip, Tab, next chip. Esc dismisses, and nothing else happens. So does getting on with the page yourself: a click, a key, a scroll or moving to another field takes the chip away without reporting anything.

Text you read in other tabs is one input to that prediction, not a precondition for it. Carat asks on every page it is allowed to act on, answers from the page itself when the page is enough, and only calls a model when the page alone leaves it unsure.

When the page you are reading names a place, a plan with a time, or someone to email, and there is no field on it worth filling, Carat instead offers the next tab: a banner centred at the bottom of the page that says `Open in Google Maps: "Seven Shores Cafe"? Tab`. Tab opens that tab (or switches to it, if you already have Maps open) with the search, event or recipient prefilled through the URL. Esc dismisses it. Carat never navigates on its own; a tab only opens or changes after a Tab press on a visible chip. It never fills more than the one field you accepted.

Carat can also act on one control on the page, in the same way: a chip on the control, one Tab, one interaction. After it has filled the title and location of a Calendar event, a chip on the Save button says `Click "Save"? Tab`. On a form, after you read "I'm a vegetarian" in a chat, a chip on the checkbox says `Check "Vegetarian"? Tab`. On a settings page, after an email said "turn the volume to 40%", a chip on the slider says `Set "Volume" to 40? Tab`. Nothing is clicked without that Tab, nothing is chained after it, and anything that deletes, sends, pays, orders or signs out never gets a chip at all.

Carat reads the page you are on as well as the tabs you left behind, and prefers what is in front of you: a Reddit thread naming a restaurant fills that page's own search box. What it will never put in a field is the page's own furniture, which is what a page mostly consists of. A value that reads back the field's label, placeholder, aria-label or current value is refused, so is the page title, the heading, the site name and a bare interface word like "Search" or "Sign in", and so is anything that is not a thing somebody named (a place, a person, an address, a date, a code, a quoted phrase). The chip says where the value came from, `from this page` or `from discord.com`.

## The errand it was built around

A friend messages you on Discord: "dinner at Seven Shores Cafe, Friday at 6?" A chip appears on the Discord page offering to open the cafe in Google Maps; you press Tab and Maps opens with the search done. Back on Discord the next chip offers to add "Dinner at Seven Shores Cafe" to Google Calendar for Friday at 6; Tab opens the event form with the title, time and location set. If you open a new Calendar event by hand instead, Carat offers the title from the Discord message (Tab), then the address from the Maps panel for the location field (Tab). Either way, no copying.

Context lives only in `chrome.storage.session` for 30 minutes and is never written to disk. Pages with a password field, `chrome://` pages, and a denylist of banking, login, and health hosts are never captured. Suggestions come from OpenAI's chat completions API called directly from the service worker, racing a regex-based local provider that also answers offline (it is enough for the Maps step and the Discord chip). The API key stays in the service worker; content scripts never receive it.

## What it predicts, and how sure it is

The content script sends a page state with every snapshot: the kind of page (`serp`, `article`, `form`, `checkout`, `search-app`, `feed`, `unknown`) read off the URL, the landmarks, the form density and the text length; how far down it you have scrolled and how tall it is, both in viewports; whether there is more below the fold; the page's own query; and what you have already accepted here. A page with a visible password field is `unknown` and carries no prior at all.

A synchronous local predictor runs on every snapshot and hangs one prior off each kind:

| Page kind | The next step | Confidence | Shows at |
| --- | --- | --- | --- |
| `serp` | click the result whose host or title carries the query | 0.8 | balanced, eager |
| `serp` | no result matches: click the first one | 0.5 | eager |
| `checkout` | once no empty field remains, click Continue or Next | 0.7 | balanced, eager |
| `form` | the same, on a plain form | 0.55 | eager |
| `form`, `checkout` | before that, fill the first empty required field a value fits | as the fill scores | every level |
| `article`, `feed`, a `serp` read past its first screen | scroll one viewport down | 0.55 | eager |
| `search-app` | the ordinary fill, as before | as the fill scores | every level |
| `unknown` | nothing | | |

A prior only shows when it clears the level's prior floor: 0.5 at eager, 0.6 at balanced, and nothing at conservative, which shows context-backed fills alone. A scroll always yields to a fill or a click that is worth showing, and is never offered twice in a row unless the page grew in between.

The model is the general case, not the first resort. It is asked when another tab's text is in play, or when the page's own prior is under the floor. Its prompt carries the page state, one paragraph on what each kind wants, and a results-page few-shot with an empty `context`. With Cloudflare credentials set, Jev gets a choice over the top candidates the local predictor assembled and its probability becomes the confidence; it ranks, it does not invent.

Enumeration grew to match. Content links are described as `role: 'link'` carrying the host they go to, at most six of them, after every control, and only from the page's own content: nothing inside a nav, header, footer, aside, menu or consent banner, no `mailto:`, `tel:` or `javascript:` link, nothing with a price in its name and nothing on the destructive-name list. They live in one function, `apps/extension/src/interact/links.ts`, so the sibling `balaji/links` branch can replace it with a fuller ranking and touch nothing else.

## Interactions

An interaction is one verb on one element the page already shows: `click` a button, a link acting as a button, a tab, a menu item or a disclosure toggle; `check` or `uncheck` a checkbox or switch (`check` a radio); `set` a slider; `choose` an option in a native select. A combobox that opens a list, a date field that opens a calendar and a card you have to pick (a flight, a fare, a room) are still one Tab each: Carat types the value, waits for the list, the calendar or the card's own Select button, presses it, and stops with the typed text in place when nothing appears within about a second. Fields and controls inside an embedded frame, like the card form Stripe drops into a checkout, are described and acted on the same way, with the chip anchored over the frame. Real links are out except on a page that says what you searched for: on a results page carat offers the first result whose site or title is the search itself, as `Open "Order Now | Quick and Easy Food Delivery" on doordash.com? Tab`. That offer comes from the page's own query rather than another tab, so it needs no earlier fill and, when the match is exact, no model call, and mailto, tel, javascript, nav, footer and cookie-banner links are never candidates.

The model never sees coordinates or DOM. Each element is a short descriptor: role, accessible name, current state or value, min/max/step for sliders, options for selects, nearby text, and a flag for the page's primary action. At most 16 elements, ranked primary first, then in-viewport, then value-bearing controls before buttons, within a 2 KB budget like fields. The model answers with the element id, the verb and, for sliders and selects, the target value. The content script performs it: a real `click()`; for range inputs the native value setter plus `input` and `change`; for `role=slider` widgets keyboard steps (ArrowLeft/Right, Home/End) computed from `aria-valuemin/max/now` and the step, writing `aria-valuenow` only if the widget ignored every key.

Buttons usually get a chip only after Carat itself filled something on that page in the last minute, and only ones that commit it (Save, Create, Done, Apply); the exception is the page's primary Search or Continue button, which `eager` offers once no empty field is left to fill. Checkboxes and sliders only get one when text from another tab names them. `packages/shared/src/destructive-names.json` holds two lists. `destructive` is never offered: delete, remove, send, sign out and the like. `money` (pay, place order, book now, subscribe) is offered only when "Offer buttons that pay, buy or book" is on in the options, off by default, and then the chip is yellow, says `Enter` instead of `Tab`, and lets Tab through to the page. Save and Create are allowed. An accepted interaction is not offered again on that page load; Esc suppresses that element for 10 minutes.

When the field or control Carat would offer is scrolled out of view, the chip has nowhere to sit, so the bottom banner asks first: `Scroll to "Add location"? Tab`. Tab scrolls the element to the middle of the window (smoothly, or at once if you prefer reduced motion), and once the page has settled the ordinary chip appears on it, so the next Tab fills or clicks. Two Tabs, two actions, and Esc at either point stops there. The scroll itself is not a fill: nothing is reported, nothing is consumed, and the page does not count as being filled until the chip after it shows. Fields anywhere on the page are described, controls from two screens above to four below; off-screen ones are ranked last, dropped first when the 2 KB budget bites, and flagged `o: 1` so the model knows. The model may also answer `scroll` on its own, only for a flagged element and only when no other verb applies; the service worker turns a scroll to something already in view into the click or check it implies, or drops it.

There is a second kind of scroll, which is the page itself. On an article, a feed or a results page you have read past, with more below the fold and nothing above it worth a chip, the banner says `Scroll down? Tab` and Tab moves the page one viewport (instantly if you prefer reduced motion). It is offered only at eager, only when no fill or click clears the next stricter level's floor, and only once until the page grows, so a feed that loads more offers it again and an article does not. Scrolling yourself while it is up counts as having done it, so it does not come back either.

## Where the two kinds of suggestion come from

Field fills use text from the page you are on and text from other tabs, the page you are on first, subject to the furniture rule above. Navigation offers only use text from the page you are on. The model (or the regex provider) extracts the entity, and a small registry in `packages/shared/src/intents.ts` builds the URL. Neither the model nor the content script ever supplies a URL; the service worker rebuilds it from the intent when the chip is accepted.

| Intent     | Trigger in the text          | Destination                                              |
| ---------- | ---------------------------- | -------------------------------------------------------- |
| `maps`     | a place name                 | Google Maps search for the place                         |
| `calendar` | a place and a time           | Google Calendar create-event with title, dates, location |
| `gmail`    | a request to email someone   | Gmail compose with the recipient                         |

If a tab already shows the destination, the chip says "Switch to" instead of "Open in" and reuses that tab.

## How readily it offers

A wrong chip costs one Esc. A missing chip costs the whole retype. So by default Carat offers a chip whenever there is a plausible candidate, and the options page has a three-way setting, `eagerness`, for people who want it quieter. Every number that used to be fixed lives in one table, `EAGERNESS` in `packages/shared/src/eagerness.ts`, and the providers, the eval and the service worker all read it.

| Level                | Confidence floor | Jev `relevant` gate | Chips per answer | Other tabs on the same site | Primary button with no fill behind it | Regex provider                                  | Model's last rule                                   |
| -------------------- | ---------------- | ------------------- | ---------------- | --------------------------- | ------------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `eager` (default)    | 0.35             | 0.25                | 4                | count as context            | offered once nothing is left to fill  | also bare capitalised names and quoted strings  | propose the best plausible value, say how sure      |
| `balanced`           | 0.55             | 0.5                 | 2                | shut out                    | no                                    | cued matches only                               | pick the likelier value when torn, else stay quiet  |
| `conservative`       | 0.7              | 0.6                 | 2                | shut out                    | no                                    | cued matches only                               | when unsure, return nothing                         |

The prior floor is the fourth number: 0.5 at eager, 0.6 at balanced, above 1 at conservative. It decides which of the page's own priors ever reach a chip, and it is also what decides whether the model is worth calling when there is nothing from another tab to answer from.

The content script still shows one chip at a time; after Tab or Esc it moves to the next field's chip from the same answer, so a wrong first guess never hides a right second one. The escape valves do not move with the level: Esc suppresses that field and source for 10 minutes, any move of your own (a click off the chip, a key that is not Tab, a scroll, focus into another field) hides it with nothing reported and nothing suppressed, a chip that is ignored goes away after 20 seconds, the page's own furniture is never a fill value, the destructive-name list never gets a chip, a money control needs the payments setting whatever the level, and nothing navigates without Tab. The popup's check line names the level when a candidate was dropped for confidence ("2 candidates under the eager floor (0.35)").

## Fast path and smart path

Every chip comes from the fast path first, and the fast path answers with whatever needs no waiting. In order: the 60s cache; the answer a navigation pre-warmed (next paragraph); or a network-free pass over the other tabs' text, from the entities the chat model predicted when that text was captured (asked once per capture, debounced 1.5s per tab, kept in session storage beside the context for the same 30 minutes) and from the regex provider. That answer goes back to the page at once with a ticket, and the configured providers race behind it inside one 6s budget: the regex provider, Jev when Cloudflare credentials are set, and the chat model with `reasoning_effort: none`, all started together. Each later answer that would change what a chip shows is handed to the content script through the ticket; per field or element the surer value wins, a tie goes to the provider later in that list, and a chip never moves, never steps back and never comes back after Esc. Only when nothing is immediate does the reply wait, inside the budget, for the first provider to answer. A regex answer shown first is cached only once a network provider has answered too, so a failed call is retried on the next request. The fast path never sees an image.

When a tab navigates to Google Maps, a Calendar event editor, Gmail or Google search, Carat starts the fast call on the navigation commit, before the page has a DOM, from the fields those pages are known to have. The answer waits in the same 60s cache, filed under the page and the context it was answered from, and the page's first request adopts it onto the live fields. This is what the `webNavigation` permission is for: Carat reads only the URL of top-frame commits, to match it against those four pages. Chrome describes the permission at install as reading browsing history.

The smart path is opt-in ("Screenshots of tabs with little text" on the options page, off by default) and never delays the chip. By default it is the same model with `reasoning_effort: low`; the optional "Smart model" field swaps in a bigger one. Either way it does two jobs.

The first is at capture time. When a tab you are reading is mostly an image, a pasted screenshot or a canvas app, Carat takes one picture of that tab while it is in front and keeps it in session storage for at most three minutes (two pictures at most, one per tab). When you switch away, the picture goes to the smart model with the capture time, and it writes back the visible text followed by a `Facts:` block: dates and times resolved against that moment ("3 days ago" under an Instagram post becomes the date), places, addresses, people and handles, prices, and one line per poster, sign, menu or map pin stating what it shows. A page cued by thin text is sent at `detail: low`; one cued by a large image is sent at `detail: high`, since the image is the part worth reading. The picture is deleted and the text joins the context store as a `vision` item, capped like a page, so the fast path can use it from then on.

The second is a slower second opinion, from text only. On pages where the fast answer was empty or unsure, `orchestrate` hands the content script a ticket and asks the smart model in the background; if its answer arrives before you act and it is more confident, the chip's value changes in place. The same goes for a chip on a control (Save, a checkbox, a slider): a surer smart answer for the same element replaces its value in place. A chip never moves to another field or element, never comes back after you dismissed it because of a smart answer, and tab offers are never refined. With the Cloudflare provider the second opinion still goes to the chat model at Base URL; Jev only picks among regex candidates. `reasoning_effort` is only sent to `api.openai.com`; other OpenAI-compatible servers get the same requests without it.

No picture is ever taken of a page Carat has offered to fill, of a page with a password field, of a denylisted host, or of a site you switched off in the popup, and nothing is photographed while the store is pinned. The popup's second debug line says what answered first and how long the page waited for it; the third says what became of the tab's last screenshot cue; a fourth, on the four pre-warmed pages, what the last navigation there pre-warmed; and a fifth, once the tab has one, the last money control pressed or fill left half done (`pressed "Pay $312.40" on aircanada.com 12s ago (Enter)`).

## Running it

```
pnpm install
pnpm build
```

Then in Chrome open `chrome://extensions`, turn on developer mode, choose "Load unpacked", and pick `apps/extension/.output/chrome-mv3`. Chrome lists a "Read your browsing history" warning for the `webNavigation` permission; "Fast path and smart path" says what it is used for. Open the extension's options page and paste an OpenAI key (or pick the `local` provider to run with no key and no network).

The chip's second line says where the value came from ("from discord.com · 2m ago"); hovering shows the provider's reason.

The popup shows what Carat currently knows and a few controls:

- An "On for <host>" switch for the tab it was opened over. Off means Carat neither reads that site nor offers chips on it. Hosts match exactly, so switching off `www.google.com` leaves `calendar.google.com` alone.
- Clear what carat remembers, at the top next to the on switch. It wipes the session store: every page and selection Carat has read, the entities it predicted from them, what you accepted or dismissed, the answer cache, any screenshot waiting to be read, and the pin. The list empties as you click and the button says "Cleared" for two seconds. Settings, the key and the per-site switches are untouched.
- Pin. While pinned nothing new is read and nothing expires, so a stray tab cannot change what Carat knows mid-demo. Clear also unpins.
- Two debug lines for the current tab: what happened to its last capture, and how its last suggestion request went. The check line names the page kind and the prior the local predictor found ("checked 5s ago on a serp (first result matches query 'doordash')"), then which check stopped the request, or each provider attempt with latency and error, or a cache hit.

`Alt+Shift+C` asks for a suggestion on the current page right now, past the answer cache and past anything you dismissed with Esc. `Alt+Shift+X` clears what Carat remembers, the same wipe as the popup's Clear button, and takes the chip on the page with it. Change either key at `chrome://extensions/shortcuts`.

## Tests and eval

```
pnpm typecheck
pnpm test
pnpm eval --provider local
```

`pnpm eval` runs the twenty-nine fixtures in `packages/providers/eval/fixtures` against a provider and prints pass/fail with latency. Pass `--provider openai` with `OPENAI_API_KEY` set in the environment to run them against the model instead of the regex fallback. `--eagerness conservative|balanced|eager` picks the level (default eager); a few fixtures expect a chip at eager only, and two negatives are allowed a weak chip there, printed as WEAK. See the fixtures README for the two keys that express this.
