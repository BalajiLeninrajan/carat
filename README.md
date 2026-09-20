# CARAT

Hack The North 2026 project

## What it does

Carat is a Chrome extension that predicts the one thing you are most likely to do next on the page you are on, and offers it as a small chip you accept with Tab. On a results page for "doordash" the chip is `Click "DoorDash Food Delivery"`. At the top of a long article it is `Scroll down`, and `Scroll more` for each screen after that; a Tab within two seconds of the last jumps instead of gliding, so paging through is as fast as the model answers. On a checkout with nothing left to type it is `Click "Continue to payment"`. On a page with an empty field and something you just read that fits it, it is `Fill Search with "Seven Shores Cafe"`. One chip, Tab, next chip. Esc means "not that": the chip goes, the refusal goes into what the model reads, and three seconds later carat asks again for something else. A second Esc buys six seconds, and from the third on it asks again every ten seconds for as long as the page is open. After five Escs in a row the chip carries a second line, `Shift+Tab: quiet for a minute`, and that key stops every request on the tab until the minute is up or `Alt+Shift+C` cuts it short.

Text you read in other tabs is one input to that prediction, not a precondition for it. Carat asks on every page it is allowed to act on, and the model answers from the page itself when the page is enough.

When what you are reading names a place, a plan with a time or someone to email, and there is nothing on the page worth doing about it, the chip is the next tab instead: a banner centred at the bottom of the page that says `Open "Seven Shores Cafe" in Google Maps`. Tab opens that tab with the search prefilled through the URL, or switches to it if you already have Maps open. Carat never navigates on its own; a tab only opens or changes after a Tab press on a visible chip.

## Ghost text

Tab does two things now. Pause for a third of a second in a field you are typing in and Carat asks the model to finish the line, then draws the rest in grey after the caret: `Dinner at Seven` grows `Shores Cafe, Friday at 6`. Tab takes it as real text through the same path a filled chip uses, so React and the editors that watch for real keystrokes get an `input` event rather than a node that appeared from nowhere. Any other key drops it. Esc drops it and stays out of that field until what is in it has really changed, so one refusal is not undone by the next character.

The model is given the page outline and the notes the chip question already carries, plus the text up to the caret, and answers in plain text: at most 24 tokens in a one-line field, 48 in a textarea or an editor. The first token is on screen before the last one is written. Nothing is inserted to make room. A native control gets a transparent mirror of itself with the grey text after the value, matched to its font, padding and scroll; an editor gets a span on the caret's own rect, so the page's DOM and its undo history are never touched.

While grey text is up Tab belongs to it, and no chip goes up on that field. An empty answer is how it hands Tab back: nothing to continue means the next-action path owns the key again. Carat never offers it in a password, card or code field, never in an empty one, and never in a one-line field with under eight pixels of room left. The switch is on the options page, on by default.

## The errand it was built around

A friend messages you on Discord: "dinner at Seven Shores Cafe, Friday at 6?" A chip on the Discord page offers to open the cafe in Google Maps; you press Tab and Maps opens with the search done. Back on Discord the next chip offers to add "Dinner at Seven Shores Cafe" to Google Calendar for Friday at 6; Tab opens the event form with the title, time and location set. If you open a new Calendar event by hand instead, Carat offers the title from the Discord message (Tab), then the address from the Maps panel for the location field (Tab). Either way, no copying.

## How it decides

Every request asks one question — what will the user do next on this page? — and gets back one answer. The model must answer: at the default eagerness there is no "nothing" reply, because a wrong chip costs one Esc and a missing chip costs the whole retype.

What the model is given, in this order, so that everything but the last part is the same on every page and the provider's prompt cache hits:

1. **Static instructions.** What each kind of action means, and how to choose between them: follow the flow the history shows, the focused control and its neighbours are the strongest signal, empty required fields come before submitting, do not lead away from the task (logout, footer links, ads), and when unsure take the primary action near the focus or the first item of the main content. Only the last paragraph moves, and only with the eagerness setting.
2. **Three few-shots.** A link in the body of a Reddit post, the first matching card on a Maps results page, and a note from Discord dropped into the Maps search box.
3. **`<goal>`** — one line for what the user is trying to get done across every tab, in their own terms: `book a flight ZRH to LON on Friday, cheapest`. Left out entirely when Carat has not worked one out, which is most pages.
4. **`<notes>`** — at most eight facts distilled from pages read recently in other tabs, newest first.
5. **`<history>`** — at most twelve lines of what happened in this tab, oldest first: `40s ago: clicked button "Add to cart"`.
6. **`<tabs>`** — the open tabs, so `switch` has something to name.
7. **The page**, last: the outline Chrome's own accessibility tree gives, landmarks indented, text inline, every control the user could operate numbered `[n]` with its role, name, value and state, the focused one marked `>> FOCUSED`, a link's domain after it, and a button that opens a dialog said to. At most 9000 characters, or 4000 when the caller wants a first fast ask, trimmed by distance from the focus.

Carat reads that tree over `chrome.debugger`, so it sees what a screen reader hears: the roles, names and states Chrome computed, including inside closed web components and cross-origin frames, which a DOM walk cannot reach. The cost is visible. Chrome puts a yellow "Chrome is being debugged by software" bar across the top of the window for as long as carat holds the debugger, and carat lets go after a minute without reading the tab, when the tab closes, and when it navigates to a page carat may not read. It never attaches to `chrome://`, `chrome-extension://`, the Web Store or a denylisted host. Dismissing the bar, or opening DevTools, takes the debugger away; that tab reads its own DOM until you next switch to it.

The DOM outline is still there, and it is what answers whenever the debugger cannot. It is the same contract line for line, built by the content script from the page itself: it walks open shadow roots and same-origin frames directly, and a cross-origin frame reports through the frame protocol. Which of the two answered is in the popup's debug line and the panel, as `evidence: cdp` or `evidence: dom (you dismissed the debugging banner)`. "How Carat reads the page" on the options page picks between them; the debugger is the default, and `The page's DOM` means never seeing the bar.

Only what is on screen goes into that outline. A block or a control whose box sits entirely above the fold, or more than a quarter of a viewport below it, is left out whole, and the controls inside it are neither numbered nor sent, so the model cannot offer a link the user would have to scroll twice to find. The focused control's own region is an exception: it is described to the end even where it runs past the fold, because the button that submits the field you are typing in is part of the same step. What is missing is said rather than hidden. The outline opens with `(1.5 screens above)` when the page is scrolled and closes with `(3.2 more screens below; 14 controls not shown)`, which is how the model knows that `scroll` is an answer. Scrolling changes the visible set, so it changes the outline's hash, and the page is asked about again.

A page built from web components reads the same way. Carat walks open shadow roots instead of stopping at the host, and takes each `<slot>` where the root puts it, so slotted text lands in composed order and a button inside a component is numbered and can be pressed like any other. Names resolve inside the root, where the `aria-labelledby` ids live. A closed root stays opaque: Chrome hands back nothing and carat does not go around that. Roots nested more than eight deep are left out, as is everything past the twenty-thousandth element of one walk.

The answer is one JSON object with `target` as its first property, streamed. The number arrives long before the label does, so the highlight ring lands on the control while the model is still writing the rest. A body the output limit cut off is salvaged rather than thrown away: `target` and `kind` come first, and a half-written value is trimmed back to its last whole sentence.

| Kind | What it does |
| --- | --- |
| `fill` | type a value into text control `[n]` |
| `click` | press button, link, checkbox, radio, tab or menu item `[n]` |
| `select` | choose an option in combobox or select `[n]` |
| `scroll` | one viewport down, when reading on is the step |
| `open` | a destination that is not on the page, named as `maps:Seven Shores Cafe` |
| `switch` | bring one of the open tabs forward |
| `none` | nothing worth offering; refused at `eager` |

At `eager` a refusal is not the end of it. An answer of `none`, one the service worker refuses, one under the floor and a provider that failed or timed out all mean the same thing — no chip — so the question goes back out once with the reason written into `<history>` as a line the model reads: `carat: the last answer was none; something on this page is still the next step`. If the second answer is nothing too, the plainest step the page itself offers stands in: read on when there is more page below, else put what the user read into the field in front of them, else press the control nearest the focus, never a risky one. The page that truly has nothing — no controls, no text, nothing below — is still allowed to say so, and the popup's check line says which of those it was.

There are no hand-written priors any more. The page kind, the results-page rule, the checkout rule and the article-scroll rule are gone: the model decides, and the regex pass is only a placeholder while it thinks.

## What Carat refuses

Validation in the service worker is about safety, not taste. It never overrules the model's choice of step, only its right to carry one out.

- The target must be a control the page actually described, and not a disabled one.
- A field is never filled with its own name or its current value.
- A `scroll` needs something below the fold.
- An `open` only goes through the intent registry in `packages/shared/src/intents.ts`: the model names a destination and an entity (`maps:Seven Shores Cafe`), and the service worker builds the URL. Neither the model nor the page ever supplies one.
- A `switch` only ever names a tab that is open.
- A page with a visible password field, a denylisted host, a site switched off in the popup and the global switch all stop the request before it is made.

### Sending, paying, deleting

There is no denylist of destructive names. The model returns an `irreversible` flag, and a regex over the label and the control's name is the backstop. An irreversible chip arms on the first Tab: it turns amber and says `Press Tab again to click "Send reply"`. The second Tab within four seconds does it; any other key, or the four seconds, stands it down. Paying, buying and booking are irreversible actions like any other: two Tabs, and no setting hides them.

## Feel

A chip has to be found before it can be answered, and a Tab that lands has to be felt. A new chip springs in over 180 ms on an ease-out-back curve, and one soft ring expands off it and fades over 600 ms; a field chip also draws a 1.5 px accent hairline round the control it is about, which fades over 900 ms, so the pill and its target read as one thing. The bottom banner rises 8 px into place instead. When the model replaces what the placeholder offered, the words cross-fade and the keycap nods for 80 ms. A chip nobody has answered after eight seconds gets one gentle pulse, 400 ms, and then lets it be.

Tab presses the keycap down for 90 ms, collapses the chip toward the control over 160 ms, and leaves a bloom on the control itself that grows from 2 px to 6 px over 450 ms, with a ripple out of a clicked button and a moment of 8% accent under a field carat just filled. A scroll banner sweeps upward as the page moves; an `open` or a `switch` shrinks toward the tab strip. An irreversible chip breathes amber on a 1.4 second cycle until its second Tab, which is the only thing here that loops besides the waiting dot. Esc fades the chip and drops it 4 px over 120 ms, and the offer that follows a refusal arrives on the same spring without the ring, so a second try is quieter than a first. Anything else the user does still clears the chip on the frame they do it, mid-animation or not. Every duration, easing and accent is a custom property on the chip's shadow root, so the whole feel is tuned in one block, and nothing carat draws is a style on the page's own elements, so no layout moves. Under `prefers-reduced-motion` none of it moves: the same states are there standing still, the pulse becomes a steady accent edge, and the ripple does not happen at all.

"Sound on Tab" in the options page, on by default, adds a note to the same moments. Two sine partials around 880 and 1320 Hz for 70 ms when a chip is accepted, a softer 440 Hz for 50 ms when Esc turns one down, and a rising pair when an irreversible chip arms. They are synthesized in the page from the Web Audio API, so there is no audio file to ship, and the AudioContext is built on the first accepted Tab and never before: every sound follows a keypress, which is the gesture Chrome wants before a page may make one.

## How readily it offers

| Level | Floor | The model's last rule |
| --- | --- | --- |
| `eager` (default) | 0.35 | always answer; there is no `none` |
| `balanced` | 0.55 | answer `none` when nothing reaches the floor |
| `conservative` | 0.7 | answer only when sure |

The floor is applied again in the service worker, so a weak answer never reaches a chip. `EAGERNESS` in `packages/shared/src/eagerness.ts` is the one table; the prompt, the providers and the service worker all read it.

## The placeholder and the model

The chip has to be up before the model has answered, so every request runs two things.

The placeholder answers in the first tick with no network at all: the regex pass over the notes, matched to the focused text control or the first empty one, as a `fill`. It has no page rules and answers `none` for most pages.

The model runs behind it with a ticket. Its answer replaces the placeholder unless the placeholder was a fill backed by something the user read and is surer of it. The ring moves as soon as `target` streams; the words change when the action lands. An answer is cached for 60 seconds per page, keyed by the outline's hash and the length of the timeline, so a page that has not changed is not asked about twice. Both the cache and the tickets that are still open are mirrored into `chrome.storage.session`: a service worker that restarts mid-answer would otherwise reply to the poll with nothing, which the chip reads as "nothing better". A ticket the new worker cannot place is answered as lost, and the page asks again on the spot.

`reasoning_effort: none` is sent only to `api.openai.com`; other OpenAI-compatible servers get the same request without it. `prompt_cache_key` is one key per origin and path. When a server rejects a parameter with a 400 that names it, Carat drops that parameter, remembers it for that model, and retries, so a model change is never more than a settings edit.

## What it reads

The content script sends the outline and nothing else about the page. Everything else is assembled in the service worker.

**The timeline** is per tab, in `chrome.storage.session`: clicks and typing reported by the page, navigations from `webNavigation`, and Carat's own accepted and dismissed chips. Values from password, card and code fields never leave the page.

**The goal** is the one thing the notes and the timeline cannot say on their own. Search flights, pick a fare, pay on the airline's site: three sites, and no single sentence the model is answering against. So after each notes distillation and each accepted chip, the same model that writes the notes is given the newest eight notes, the last twelve timeline lines across every tab and the goal it wrote last time, and answers with one line of at most 120 characters or `none`. It runs at most once every twenty seconds, lives half an hour, and goes when two derivations running answer `none`, when the user clicks the × beside it in the popup, or on any clear. `<goal>` sits inside the cached prefix, so a goal that changes costs one prefix-cache miss; a goal changes on the order of minutes and a page on the order of seconds, and the warm-up on the next navigation sends the new one.

**The notes** are what the user read elsewhere. When a tab is hidden, the text it last captured goes to the model, which writes at most five self-contained facts; they live for an hour. Without a model, or when the call fails, the regex candidates stand in so the offline path still has something. Opt in to "Screenshots of tabs with little text" and a tab that is mostly an image is photographed once while it is in front, read into text by the vision model, and distilled into notes the same way; the picture is deleted.

Context lives only in `chrome.storage.session` and is never written to disk. The API key stays in the service worker; content scripts never receive it.

## Running it

```
pnpm install
pnpm build
```

Then in Chrome open `chrome://extensions`, turn on developer mode, choose "Load unpacked", and pick `apps/extension/.output/chrome-mv3`. Chrome lists a "Read your browsing history" warning for the `webNavigation` permission, which is what the timeline's navigation lines come from, and an "Access page debugger backend" warning for `debugger`, which is what reads the accessibility tree. The first page carat reads raises the yellow debugging bar; it goes when carat lets the tab go. Open the extension's options page and paste an OpenAI key (or pick the `local` provider to run with no key and no network, which means the placeholder alone).

The popup shows what Carat currently knows and a few controls:

- An "On for <host>" switch for the tab it was opened over. Off means Carat neither reads that site nor offers chips on it. Hosts match exactly.
- Pin. While pinned nothing new is read and nothing expires, so a stray tab cannot change what Carat knows mid-demo. Clear also unpins.
- The goal, when there is one, with a × that drops it. The next derivation is free to find another.
- Debug lines for the current tab: what happened to its last capture, and how its last request went — what answered first and how long the page waited, each provider's latency, the action's kind, the model's own label and reason, whether it asks for a second Tab, why one was refused, what the second ask was for, whether the model replaced the placeholder, and, when the page ended up with no chip on it, why.

Three keys, all of them changeable at `chrome://extensions/shortcuts`:

- `Alt+Shift+C` asks again on the current page right now, past the 60-second cache and past anything dismissed with Esc.
- `Alt+Shift+X` clears what carat remembers.
- `Alt+Shift+D` opens the debug panel on the page, and closes it again.

## The debug panel

`Alt+Shift+D` puts a panel in the bottom-right corner of the page with what carat is thinking about that tab, live. It is off until you press the key, and nothing beyond the popup's ordinary debug line is collected before that; closing it stops the collecting and throws away what was collected. Drag it by its header, resize it from its top-left corner, close it with the same key or with Esc while it has focus. It is one of carat's own surfaces, so clicking in it does not take the chip down, and it never takes Tab from the page: the key only reaches the panel once you have clicked into it.

Four sections:

- **Request.** The outline exactly as it was sent, which reader produced it and why the fallback stood in when it did, with the numbered controls picked out, the `<notes>`, `<history>` and `<tabs>` blocks as the prefix carries them, `now`, the eagerness level, the answer cache key and the `prompt_cache_key`. "copy request" puts the whole request on the clipboard as JSON.
- **Answer.** What the placeholder had, and what the model replaced it with: kind, target, label, confidence, irreversible, reason. Under that, the reply exactly as it streamed, which provider won the race, the placeholder, first-partial and final timings, whether the prefix was warm, the validator's line for each pass, and the reason there is no chip when there is none.
- **Timeline.** The tab's history entries and the scheduler's own events in one scrolling log: which trigger asked and what refused it, memo hits, snoozes and lost tickets, each with a relative timestamp.
- **Gate.** The last verdict and every precondition behind it: the global switch, the per-site switch, the denylist, a password field, whether there was a snapshot at all, whether the tab is hidden, and how much of a Shift+Tab minute is left.

## Tests and eval

```
pnpm typecheck
pnpm test
pnpm eval
```

`pnpm eval` runs the fixtures in `packages/providers/eval/fixtures` against a provider and prints pass/fail with latency. With the default `--provider local` each fixture is judged against `expectLocal`: what the offline placeholder must answer with no network, which for most pages is nothing. Pass `--provider openai` with `OPENAI_API_KEY` set to judge the model against `expect` instead, which is the action itself: the control, the kind, and for a negative the controls it must not touch. `--eagerness conservative|balanced|eager` overrides the level in the fixture. See the fixtures README for the shape.
