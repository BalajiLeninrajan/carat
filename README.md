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

The engine is the `listening` prototype, ported file for file (see Provenance below). Carat reads the page through Chrome's accessibility tree over `chrome.debugger`, waits until you have been idle for a moment, asks the model one question, what will the user do next on this page, and shows the answer. There is no placeholder answer, no second-guessing of the model, and no fallback when the debugger cannot attach: on a page where it cannot read (Chrome's own pages, the Web Store, a blocked host, or a tab where you pressed Cancel on the debugging bar) it does nothing and the debug panel says so.

What the model is given, in an order that keeps everything but the page stable so the provider's prompt cache hits: the instructions and a few illustrative examples; `<browser>`, the other open tabs and the fact that it may open a URL or run a search; `<notes>`, facts kept from pages you left; `<history>`, what happened in this tab; then the page as a numbered outline from the accessibility tree, the focused control marked, with `<selection>` carrying any text you have highlighted. A highlight is itself a trigger: change it and Carat asks again.

The answer is one streamed JSON object, `kind` and `target` first so the ring lands on the control before the label arrives.

| Kind | What it does |
| --- | --- |
| `click` | press button, link, checkbox, radio, tab or menu item `[n]` |
| `fill` | type a value into text field `[n]`, only when the page, notes or history clearly imply it |
| `select` | choose the option whose text is the value in combobox `[n]` |
| `submit` | press Enter in text field `[n]`; search boxes and many forms submit this way |
| `switch` | bring open tab `[Tn]` forward |
| `open` | put the value in this tab's address bar: a URL goes there, anything else is searched |
| `scroll` | one screen down, only when nothing in view is worth acting on |

`irreversible: true` (sending, paying, deleting, submitting an order) arms the chip: the first Tab shows what it would do, the second does it. Ghost text is the prototype's completion path: pause while typing and the continuation appears inline; Tab accepts it.

### Provenance

`apps/extension/src/engine/` is `origin/listening`'s `src/` with bodies intact: `background/{actuate,ax,axmirror,browser,cdp,complete,history,llm,notes,outline,predict,prompts,visits}.ts`, `content/{ghost,ring}.ts`, `shared/{protocol,redact,settings}.ts`. Adapted, not copied: imports, WXT entrypoints, and two additions to `prompts.ts`: the `scroll` kind and the `<selection>` block. Ours on top: the chip and its sound, the popup with Clear, the status pill, the debug panel, the three shortcuts. Removed with the old engine: the DOM outline and its frame protocol, the regex and race providers, eagerness, the goal, the notes distiller, the grounding validator and every stand-in.

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

Then in Chrome open `chrome://extensions`, turn on developer mode, choose "Load unpacked", and pick `apps/extension/.output/chrome-mv3`. Chrome lists a "Read your browsing history" warning for the `webNavigation` permission, which is what the timeline's navigation lines come from. Open the extension's options page and paste an OpenAI key (or pick the `local` provider to run with no key and no network, which means the placeholder alone).

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

- **Request.** The outline exactly as it was sent, with the numbered controls picked out, the `<notes>`, `<history>` and `<tabs>` blocks as the prefix carries them, `now`, the eagerness level, the answer cache key and the `prompt_cache_key`. "copy request" puts the whole request on the clipboard as JSON.
- **Answer.** What the placeholder had, and what the model replaced it with: kind, target, label, confidence, irreversible, reason. Under that, the reply exactly as it streamed, which provider won the race, the placeholder, first-partial and final timings, whether the prefix was warm, the validator's line for each pass, and the reason there is no chip when there is none.
- **Timeline.** The tab's history entries and the scheduler's own events in one scrolling log: which trigger asked and what refused it, memo hits, snoozes and lost tickets, each with a relative timestamp.
- **Gate.** The last verdict and every precondition behind it: the global switch, the per-site switch, the denylist, a password field, whether there was a snapshot at all, whether the tab is hidden, and how much of a Shift+Tab minute is left.

## Elasticsearch context layer

Carat can optionally use Elasticsearch as its longer-lived context layer. In
the options page, fill in:

- Elasticsearch URL
- Elasticsearch API key
- Index prefix, default `carat`
- Optional inference endpoint id, or `default`

With a URL and API key set, the background worker auto-creates four indices:

- `<prefix>-observations`: captured page text, selections and vision text
- `<prefix>-facts`: distilled actionable facts from pages the user left
- `<prefix>-actions`: accepted and dismissed Carat suggestions
- `<prefix>-tasks`: unresolved tasks grouped from facts by action type, likely entity and date bucket, carrying `status: conflict` and a reason when two sources disagree

It also auto-creates an ingest pipeline named `<prefix>-carat-ingest` and sends
every write through it. The pipeline adds `received_at`, normalized host/origin
fields, lightweight ECS-style `event.*` metadata, `carat.*` schema metadata,
and redacts card-like digit sequences before the document is indexed. Carat
still does app-level extraction and conflict detection before indexing; the
ingest pipeline handles Elastic-native normalization and safety cleanup at
write time.

If the inference endpoint id is blank, retrieval is BM25/full-text only. Set it
to `default` to use Elastic's deployment default `semantic_text` endpoint, or to
a specific `semantic_text` inference endpoint id. New indices then include a
`text_semantic` field and Carat retrieves with RRF over BM25 plus semantic
matching. The extension does not create custom inference endpoints itself;
create one in Elastic/Kibana first if you do not want to use `default`.
Existing indices are left alone, so delete the demo indices or use a fresh
prefix after changing the inference endpoint.

Distilled facts also pass through a small messy-context resolver. A fact like
`Dinner at Seven Shores Cafe on Friday at 6` becomes an unresolved
`calendar_event` task. If another source later says the same event is at 7,
the task keeps one document and flips to `status: conflict` with a
`conflictReason`, so the disagreement travels with the task rather than beside
it.

Before each model call, Carat works out what the page in front of the user can
actually finish. The host decides when it is one of Carat's own destinations
(Calendar, Maps, Gmail) and then it decides alone; otherwise the capability has
to be named by a control the model could type into, so an article that merely
mentions a date does not claim to be a calendar. Retrieval is then two queries
run side by side under a single deadline, over two different windows, because a
task and a fact age differently:

- **the task**: `<prefix>-tasks`, unresolved or in conflict, filtered to that
  capability, from the last **5 minutes** — hot intent, the same window the
  cleanup sweep expires tasks on. Ranked by relevance to the page rather than
  recency, with conflicts boosted, and capped at one.
- **the context behind it**: `<prefix>-observations` and `<prefix>-facts` from
  the last **12 hours**, hybrid-ranked, capped at three.

An ES|QL rollup adds one line counting what is still open, and only runs when
the page can complete something. The result reaches the model as one `[task]`
line naming the single thing to finish and a few `[elasticsearch]` lines
supporting it — the task line goes in front of the user's own notes, the
supporting lines behind them, so retrieved context can never push out what the
user actually read. When the task line says `conflict`, the prompt tells the
model not to fill the disputed detail. Accepting or dismissing a chip runs a
delete-by-query that closes the matching task out, so the loop ends where it
started.

## Tests and eval

```
pnpm typecheck
pnpm test
pnpm eval
```

`pnpm eval` runs the fixtures in `packages/providers/eval/fixtures` against a provider and prints pass/fail with latency. With the default `--provider local` each fixture is judged against `expectLocal`: what the offline placeholder must answer with no network, which for most pages is nothing. Pass `--provider openai` with `OPENAI_API_KEY` set to judge the model against `expect` instead, which is the action itself: the control, the kind, and for a negative the controls it must not touch. `--eagerness conservative|balanced|eager` overrides the level in the fixture. See the fixtures README for the shape.
