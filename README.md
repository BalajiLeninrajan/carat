# CARAT

Hack The North 2026 project.

Cursor's tab-complete, for text fields on the web. Type into any input or textarea, a dim
continuation appears after your caret, **Tab** accepts it.

The interesting part is where the context comes from. Carat does not scrape HTML — it reads
**Chrome's accessibility tree** over the DevTools Protocol (`Accessibility.getFullAXTree`), the
same semantic view a screen reader gets: roles, accessible names, values, landmarks, and the
label attached to the field you are in. A support console's HTML is a few hundred kilobytes;
its accessibility outline is about two, and it already says what everything *is*.

Here is the real outline it built for `test/fixtures/form.html` — 1,204 characters, the entire
page:

```
PAGE: Ticket #4821 — Support Desk (http://localhost/fixtures/form.html)
banner:
  text: Support Desk
main:
  heading(1): Printer offline after firmware update
  region "Conversation":
    text: Customer · 2 days ago
    text: Since the 3.2 firmware update my HP M452 shows as offline after every
          reboot. … Three machines on the same subnet are affected.
    text: Customer · 1 hour ago
    text: It says 3.2.0.4711. The other two are on the same build.
  form:
    group "Reply":
      combobox "Status" = Awaiting customer
      textbox "Subject" = Re: Printer offline after firmware update
      >> FOCUSED textbox "Reply body"
      textbox "Internal note (not sent to customer)"
      button "Send reply"
```

That outline plus the text you have typed is the whole prompt. Type
`Thanks for the details. Could you` into the reply box and `gpt-5.6-luna` answers:

> confirm whether all three printers are on firmware 3.2.0.4711 and share their configuration
> pages?

It knows there are three of them and knows the build number, because both are in the outline.
The focused field's own text is deliberately *not* — it is sent separately as the prefix, so
the model never sees it twice.

## Install

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the
`dist/` folder. The options page opens on first install; paste an OpenAI API key and hit
**Test connection**.

`npm run watch` rebuilds on save (hit the reload icon on the extension card to pick up changes).

### The model

The default is **`gpt-5.6-luna`**, set in `src/shared/types.ts` and editable in the options
page. The client speaks both `/v1/responses` and `/v1/chat/completions` and drops request
parameters a model rejects (keyed off the API's own `error.param`), so pointing it at a
different model is a one-field change. It sends `reasoning.effort: "none"` — ghost text is a
latency path, and reasoning on a 40-token completion is all cost and no benefit.

The API key lives in `chrome.storage.local` and goes straight from the service worker to
OpenAI. If you would rather it not sit in the browser, point **Base URL** at your own proxy.

## Next-action prediction

Text is half of it. When the text model has nothing to add — you have finished the thought —
or right after you click or change something, Carat predicts what you will **do** next and
rings that control with a chip saying what <kbd>Tab</kbd> will do:

| Kind | What Tab does | Example chip |
|---|---|---|
| click | presses a button, link, checkbox, tab | `Tab Tab  Send reply` |
| focus | moves to a field — with predicted text already waiting as ghost text | `Tab  Postcode` |
| select | picks a dropdown option | `Tab  Status: Resolved` |

It is the same outline as text mode, except every control gets a number:

```
    [1] combobox "Status" = Awaiting customer
      option "Resolved"
    >> FOCUSED [3] textbox "Reply body" = Thanks for the details. Could you confirm…
    [5] button "Send reply"
```

…plus a short history of what you just did (`clicked button "Reply"`, `selected "Resolved" in
combobox "Status"`), kept per tab. The model answers with one JSON object naming a `[n]`, and
the worker maps that number back to the live element through CDP: it resolves the
accessibility node and fires an event *on* the element, which the content script catches.
Nothing is written into the page.

The rules that keep it from being dangerous:

- **Anything that sends, submits, pays, deletes or publishes takes two Tabs.** The first arms
  it (chip turns amber, reads "again to"), scrolls the button into view, and times out after
  three seconds. A reflexive Tab can never email a customer, and nobody confirms a button
  they cannot see. Irreversibility is the model's opinion *or* a pattern match on the label,
  never the model alone.
- **"none" beats a guess.** The prompt says so, predictions below the confidence threshold
  (options page, default 0.55) are never shown, and a target that isn't a real control on the
  page is discarded no matter what the model says.
- **Only after you interact.** Predictions fire after clicks, changes and finished typing —
  never on page load, so browsing a page does not send it anywhere.
- **Esc means no.** A dismissed suggestion is not offered again on that page, and the
  dismissal goes into the history so the model learns from it too.

Each prediction is one API call per interaction, so it costs more than text mode. Turn it off
in the options page if you only want text.

## Keys

| Key | |
|---|---|
| <kbd>Tab</kbd> | accept the suggestion — text, or the highlighted action |
| <kbd>Esc</kbd> | dismiss it |
| <kbd>Ctrl</kbd>+<kbd>.</kbd> | force a suggestion now: text if you are in a field, otherwise the next action |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> | toggle the debug HUD |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> | turn Carat on/off |

The HUD shows time-to-first-token, the context source in use, session accept rate, how many
suggestions were served with no network call at all, and the exact prompt that was sent.

## How it holds together

```
content script                 service worker                     OpenAI
─────────────                  ──────────────                     ──────
focusin / input / keydown ───► debounce, coalesce, abort
                               chrome.debugger.attach(tabId)
                               Accessibility.getFullAXTree ──┐
                               (cached ~4s per tab + url)    │
                                                             ▼
                                             AX nodes → compact page outline
                                                             │
                               ◄── streamed deltas ──────────┴──► POST /v1/responses
ghost overlay grows
Tab → insert, Esc → dismiss
```

| File | |
|---|---|
| `src/background/ax.ts` | debugger attach/detach, AX tree fetch, cache, fallback switch |
| `src/background/context.ts` | AX nodes → the outline above, budgeted by relevance |
| `src/background/prompt.ts` | system prompt, few-shots, and completion repair |
| `src/background/llm.ts` | streaming OpenAI client for both API surfaces |
| `src/content/ghost.ts` | the mirror overlay that draws ghost text |
| `src/content/snapshot.ts` | DOM+ARIA outline used when CDP is unavailable |
| `src/content/action-overlay.ts` | the ring and chip for a predicted action |
| `src/background/history.ts` | per-tab log of what you just did, for the predictor |
| `src/content/hud.ts` | debug HUD |

Three things do most of the work for perceived speed:

- **Prefix reuse.** If you type the next character of a visible suggestion, the ghost is trimmed
  locally and no request is made. Most keystrokes inside a good suggestion cost nothing.
- **The AX tree is never fetched on the hot path.** It is cached per tab and URL for a few
  seconds; a tree two seconds stale is still right about what the page is.
- **Deltas stream into the overlay**, so the first words appear well before the model is done.

## What it does not read

Password, hidden, payment and one-time-code fields are never read, from the focused field or
from the outline. Card numbers (Luhn-checked), SSNs and API-key-shaped strings are masked
wherever they appear. Hostnames in the options page's blocklist are checked before the
accessibility tree is even requested.

## The debugging banner

Reading the real accessibility tree means attaching `chrome.debugger`, which makes Chrome show
a "Carat started debugging this browser" bar. Dismissing it is not fatal: that tab silently
falls back to the DOM+ARIA outline in `snapshot.ts`, and the HUD's `context` row tells you
which one is live. Cross-origin iframes always use the fallback. You can turn CDP off entirely
in the options page.

## Tests

```bash
npm test         # 36 unit tests: outline builder, action numbering and parsing, redaction
npm run test:e2e # drives real Chrome end to end (see below)
npm run typecheck
```

### The end-to-end harness

`npm run test:e2e` launches real Chrome, loads `dist/`, points the extension at a mock OpenAI
server, types into the support-ticket fixture, and asserts on what actually happens: that a
request went out, what the prompt contained, that ghost text rendered, that <kbd>Tab</kbd>
appended it without moving focus, and that the HUD reports the CDP accessibility tree as the
context source — then keeps going: the text model goes quiet, `Send reply` is highlighted,
the first Tab arms it and scrolls it into view, the second clicks it, and the click shows up
in the history for the next prediction. No API credits spent. `CARAT_NO_CDP=1` runs the
whole thing through the DOM fallback instead of the accessibility tree.

Two things worth knowing if you touch it:

- **Chrome no longer honours `--load-extension`.** Unpacked extensions load over CDP
  (`Extensions.loadUnpacked`), which needs `--enable-unsafe-extension-debugging`. If Chrome
  silently ignores your extension, that is why.
- **`CARAT_API_KEY=... npm run test:e2e` runs the same script against the real API** (add
  `CARAT_MODEL=` to override the model). Exact-text assertions relax; everything else holds.
  `--headed` shows the browser.

`CARAT_DEBUG=1` additionally dumps the raw accessibility tree to `test/.tmp/axtree.json`;
`test/replay.ts` replays a captured tree through the outline builder without a browser.
`test/fixtures/axtree-form.json` is such a capture, and the unit tests assert against it —
every one of those assertions is a bug it caught (controls hidden inside `<label>`, page text
buried under anonymous wrapper divs, the outline feeding Carat's own ghost text back into the
next prompt, and a mark phase that never terminated because Chrome reuses node ids).

`test/fixtures/` also holds pages worth opening by hand:

- **`form.html`** — a support ticket with landmarks, a conversation, and a reply form. The
  showcase: click into *Reply body*, type `Thanks for the details. Could you`, and the
  suggestion should reference the firmware build named earlier on the page.
- **`tracked-input.html`** — installs React's own value-tracking trick. Accepting a suggestion
  here must turn the verdict line green; if it does not, the accept path has stopped writing
  through the native value setter and would silently break on React sites.
- **`metrics.html`** — fields designed to break the ghost overlay: 26px text with a thick
  border, right-aligned serif, RTL, monospace with lopsided padding, a narrow field that
  scrolls horizontally, and a textarea that scrolls vertically.

Worth checking by hand on a real page: a password field never suggests, <kbd>Esc</kbd> does not
close the site's own dialog when a ghost is showing, and clicking **Cancel** on the debugging
banner flips the HUD to `DOM fallback` without breaking suggestions.

The overlays set `aria-hidden="true"` on their shadow hosts. That is not politeness — without
it, Carat's own suggestion lands in the next accessibility-tree read and the model starts
completing its own output.

## Known limits

- `<input>` and `<textarea>` only. Rich `contenteditable` editors (Gmail, Notion, Docs) are not
  handled yet — they need caret-anchored inline spans rather than a mirror overlay.
- Completion happens at the end of the field. If the caret is mid-text the suggestion is
  suppressed rather than guessed.
- One suggestion at a time, no alternatives to cycle through.
