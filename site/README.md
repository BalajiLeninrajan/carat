# site

The landing page. One standalone `index.html` — no build, no dependencies, no
framework. Fonts come from Google Fonts; everything else is inline.

Serve it locally with anything:

```
python3 -m http.server -d site 8000
```

Deploying: point GitHub Pages at `/site` on `main`, or drop the folder on any
static host. There is nothing to compile.

**Design system** — [Catppuccin](https://catppuccin.com) Latte in light and
Mocha in dark, the same palette the extension's own options page uses, with
neubrutalist treatment: 3px borders, hard offset shadows, near-zero radius.
Type is Bricolage Grotesque (display), Public Sans (body), JetBrains Mono
(code and task lines). The header toggle overrides the OS theme in both
directions; with no toggle the page follows `prefers-color-scheme`.

Every animation sits behind `prefers-reduced-motion`, and the hero rests in
its finished state so the first frame shows the outcome rather than an empty
form.
