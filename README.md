# CARAT

Hack The North 2026 project

## What it does

Carat is a Chrome extension that predicts the one thing you are most likely to do next on the page you are on, and offers it as a small chip you accept with Tab. On a results page for "doordash" the chip is `Click "DoorDash Food Delivery"`. Halfway down an article it is `Scroll down`. On a checkout with nothing left to type it is `Click "Continue to payment"`. On a page with an empty field and something you just read that fits it, it is `Fill Search with "Seven Shores Cafe"`. One chip, Tab, next chip. Esc dismisses, and nothing else happens.

Text you read in other tabs is one input to that prediction, not a precondition for it. Carat asks on every page it is allowed to act on, and the model answers from the page itself when the page is enough.

When what you are reading names a place, a plan with a time or someone to email, and there is nothing on the page worth doing about it, the chip is the next tab instead: a banner centred at the bottom of the page that says `Open "Seven Shores Cafe" in Google Maps`. Tab opens that tab with the search prefilled through the URL, or switches to it if you already have Maps open. Carat never navigates on its own; a tab only opens or changes after a Tab press on a visible chip.

## The errand it was built around

A friend messages you on Discord: "dinner at Seven Shores Cafe, Friday at 6?" A chip on the Discord page offers to open the cafe in Google Maps; you press Tab and Maps opens with the search done. Back on Discord the next chip offers to add "Dinner at Seven Shores Cafe" to Google Calendar for Friday at 6; Tab opens the event form with the title, time and location set. If you open a new Calendar event by hand instead, Carat offers the title from the Discord message (Tab), then the address from the Maps panel for the location field (Tab). Either way, no copying.

## How it decides

Every request asks one question — what will the user do next on this page? — and gets back one answer. The model must answer: at the default eagerness there is no "nothing" reply, because a wrong chip costs one Esc and a missing chip costs the whole retype.

What the model is given, in this order, so that everything but the last part is the same on every page and the provider's prompt cache hits:

1. **Static instructions.** What each kind of action means, and how to choose between them: follow the flow the history shows, the focused control and its neighbours are the strongest signal, empty required fields come before submitting, do not lead away from the task (logout, footer links, ads), and when unsure take the primary action near the focus or the first item of the main content. Only the last paragraph moves, and only with the eagerness setting.
2. **Three few-shots.** A link in the body of a Reddit post, the first matching card on a Maps results page, and a note from Discord dropped into the Maps search box.
3. **`<notes>`** — at most eight facts distilled from pages read recently in other tabs, newest first.
4. **`<history>`** — at most twelve lines of what happened in this tab, oldest first: `40s ago: clicked button "Add to cart"`.
5. **`<tabs>`** — the open tabs, so `switch` has something to name.
6. **The page**, last: an accessibility-style outline read from the DOM, landmarks indented, text inline, every control the user could operate numbered `[n]` with its role, name, value and state, the focused one marked. At most 9000 characters, trimmed by distance from the focus.

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

## How readily it offers

| Level | Floor | The model's last rule |
| --- | --- | --- |
| `eager` (default) | 0.35 | always answer; there is no `none` |
| `balanced` | 0.55 | answer `none` when nothing reaches the floor |
| `conservative` | 0.7 | answer only when sure |

The floor is applied again in the service worker, so a weak answer never reaches a chip. `EAGERNESS` in `packages/shared/src/eagerness.ts` is the one table; the prompt, the providers and the service worker all read it.

## The placeholder and the model

The chip has to be up before the model has answered, so every request runs two things.

The placeholder answers in the first tick with no network at all: the regex pass over the notes, matched to the focused text control or the first empty one, as a `fill`. It has no page rules and answers `none` for most pages. With Cloudflare credentials, Jev gets one choice question over the numbered controls plus a scroll and nothing, fed the same notes and history, and its calibrated probability becomes the confidence.

The model runs behind it with a ticket. Its answer replaces the placeholder unless the placeholder was a fill backed by something the user read and is surer of it. The ring moves as soon as `target` streams; the words change when the action lands. An answer is cached for 60 seconds per page, keyed by the outline's hash and the length of the timeline, so a page that has not changed is not asked about twice.

`reasoning_effort: none` is sent only to `api.openai.com`; other OpenAI-compatible servers get the same request without it. `prompt_cache_key` is one key per origin and path. When a server rejects a parameter with a 400 that names it, Carat drops that parameter, remembers it for that model, and retries, so a model change is never more than a settings edit.

## What it reads

The content script sends the outline and nothing else about the page. Everything else is assembled in the service worker.

**The timeline** is per tab, in `chrome.storage.session`: clicks and typing reported by the page, navigations from `webNavigation`, and Carat's own accepted and dismissed chips. Values from password, card and code fields never leave the page.

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
- Debug lines for the current tab: what happened to its last capture, and how its last request went — what answered first and how long the page waited, each provider's latency, the action's kind, the model's own label and reason, whether it asks for a second Tab, why one was refused, and whether the model replaced the placeholder.

`Alt+Shift+C` asks again on the current page right now, past the 60-second cache and past anything dismissed with Esc. Change the key at `chrome://extensions/shortcuts`.

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
