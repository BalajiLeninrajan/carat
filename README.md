# Caret

A Chrome extension that guesses the one thing you are about to do on the page
in front of you, and does it when you tap a key.

Caret reads the page through Chrome's accessibility tree, searches Elasticsearch
for what you were already in the middle of, asks a model what comes next, and
puts a small chip beside the control it means. Tap the right Shift and the chip
acts: it presses the button, fills the field, picks the option, opens the tab, or
reads on down the page. Esc turns it down.

- On a search results page: `Click "DoorDash Food Delivery"`
- Halfway down a long article: `Scroll more`
- On a checkout with nothing left to type: `Click "Continue to payment"`
- After a friend messages you a restaurant: `Open "Seven Shores Cafe" in Google Maps`
- On an empty Calendar event, an hour after that message: `Fill Title with "Dinner at Seven Shores Cafe"`

Pause while typing and the same key finishes the line instead. Caret writes the
rest in grey after the caret, `Dinner at Seven` grows `Shores Cafe, Friday at 6`,
and the key takes it as real typing, so React and the editors that watch for
keystrokes see an ordinary `input` event.

`Ctrl+Shift+K` is for anything bigger than one step. Type what you want done on
the page and Caret works at it, one step at a time, until it is finished or you
stop it.

## Install

You need Node 22 or newer and pnpm.

```sh
pnpm install
pnpm build
```

Then open `chrome://extensions`, turn on developer mode, click **Load unpacked**
and pick `apps/extension/.output/chrome-mv3`. Or grab the zip from the
[latest release](https://github.com/BalajiLeninrajan/caret/releases) and load
the folder you unzip.

Two things Chrome will tell you about:

- It lists a "Read your browsing history" warning. That is the `webNavigation`
  permission, which is how Caret knows you navigated.
- A yellow "Caret started debugging this browser" bar sits at the top of every
  tab Caret reads. Closing it detaches the debugger and Caret goes quiet on that
  tab until you reload.

Open the options page and fill in two things. An OpenAI API key, which nothing
works without; any OpenAI Responses API endpoint does, so a proxy or a local
server works too. And your Elasticsearch URL and API key, which is where Caret
keeps what it has read and where it looks before every guess. Caret creates the
indices and the ingest pipeline on the first write, so a cluster and a key are
all it needs from you. Set the inference endpoint id to `default` to turn on
semantic retrieval; leave it blank and retrieval stays lexical.

## Keys

| Key | What it does |
| --- | --- |
| Right Shift (tap) | Accept the chip, or take the ghost text |
| Esc | Turn down the chip, and ask again in a few seconds |
| `Ctrl+Shift+K` | Type an instruction and let Caret carry it out |
| `Alt+Shift+C` | Ask again right now |
| `Alt+Shift+X` | Clear what Caret remembers |
| `Alt+Shift+D` | Show what Caret is thinking about this page |

The accept key is Tab instead if you pick that on the options page, which costs
the page its Tab for as long as a chip is up. The last four are Chrome commands
and you can rebind them at `chrome://extensions/shortcuts`.

## How it works

```
  ┌─ the page ────────────────────────────────────────────────┐
  │  content script: chip · ghost text · ring · palette       │
  └──┬─────────────────────────────────────────────▲──────────┘
     │ focus, typing, scroll, selection, copies    │ target, label, text
     ▼                                             │
  ┌─ service worker ──────────────────────────────────────────┐
  │  listen → outline → retrieve → predict → actuate          │
  │  notes · timeline · clipboard · tasks                     │
  └──┬────────────────┬──────────────────┬────────────────────┘
     │ chrome.        │ offscreen        │ Responses API
     │ debugger       │ document         │
     ▼                ▼                  ▼
  accessibility    microphone,        the model
  tree of the tab  system clipboard      ▲
     │                                   │
     │ every reading, fact, action       │ [task] the one thing
     ▼                                   │ this page can finish
  ┌─ Elasticsearch ───────────────────────┴───────────────────┐
  │  observations · facts · tasks · details · actions         │
  │  ingest pipeline · RRF over BM25 + semantic_text          │
  └───────────────────────────────────────────────────────────┘
```

The service worker owns everything. The content script sends what you did and
draws what comes back; it never sees the API key and never decides anything.

Every page Caret reads goes to Elasticsearch: the outline itself, the facts
distilled out of it, the personal details it learned about whoever the page was
about, and every chip you took or turned down. Facts group into tasks by what
they would finish, so `Dinner at Seven Shores Cafe on Friday at 6` becomes a
`calendar_event` waiting on a title, a time and a location. When a second source
says seven instead of six, the task keeps one document and flips to
`status: conflict`, and the prompt tells the model to leave that detail alone
rather than guess between them.

That is what the guess is made of. Before each call Caret works out what the
page in front of you can actually finish, from the host when it is Calendar,
Maps or Gmail and from the controls otherwise, then runs two searches side by
side under one deadline: the open task for that capability from the last five
minutes, ranked against the page with conflicts boosted, and the context behind
it from the last twelve hours, RRF over BM25 and `semantic_text`. An ES|QL
rollup counts what is still open. The result reaches the model as one `[task]`
line naming the single thing to finish and a few `[elasticsearch]` lines
supporting it.

So what the model is given, in an order that keeps the provider's prompt cache
warm: the instructions, the other open tabs, the retrieved task ahead of the
notes Caret kept from pages you left, what has happened in this tab, and then
the page as a numbered outline of its accessibility tree with the focused
control marked. It answers with one streamed JSON object, target first, so the
ring lands on the control before the words arrive. Taking the chip or turning it
down runs a delete-by-query that closes the task out, and the loop ends where it
started.

## What it will not do

- It never navigates on its own. A tab opens or changes only after you tap the
  key on a chip you can see.
- Anything irreversible takes two taps. The chip turns amber and says
  `Press again to click "Send reply"`, and four seconds of nothing stands it
  down. That covers sending, paying, deleting and ordering, and no setting
  hides it.
- It never fills a field with its own name or the value already in it, never
  targets a control the page did not describe, and never targets a disabled one.
- It goes quiet on any page showing a password field, on banks and password
  managers, on hosts you blocklist, and on any site you switch off in the popup.
- Password, card and one-time-code fields are never read, never filled, and
  never copied into what Caret remembers.

What Caret holds in the browser lives in `chrome.storage.session` and is gone
when Chrome closes; what outlives the session is in your own cluster, under your
own prefix, where you can read it and delete it. The ingest pipeline strips
card-like digit sequences before anything is indexed. The reading memory, the
microphone and the system clipboard are each off until you turn them on.

## Settings worth knowing

Open the options page from the extension menu.

- **Reading memory.** When you leave a page, Caret asks the model to note the
  facts on it you might act on elsewhere, and keeps them for an hour. The page's
  text goes to the API to do this, so it is off by default.
- **Listen through the microphone.** Transcribes what it hears into the same
  notes. Audio is never stored. Off by default.
- **Read the system clipboard.** What you copy in the browser is always a note;
  this adds what you copy in other apps. Chrome asks for the permission when you
  tick the box and Caret hands it back when you untick it.

The popup has a per-site switch, a Pin that freezes what Caret knows, and the
current goal with a × to drop it.

## Development

```sh
pnpm --filter caret-extension dev    # Chrome with the extension loaded, hot reload
pnpm typecheck
pnpm test
```

`apps/extension/src/engine/` is the prediction engine, ported from the
`listening` prototype. Everything around it, the chip, the popup, the debug
panel, the clipboard notes and the Elasticsearch layer, is Caret's own.

## License

MIT. See [LICENSE](LICENSE).
