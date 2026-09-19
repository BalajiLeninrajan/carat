# Eval fixtures

One JSON file per page. Each holds a `NextActionRequest` exactly as the content
script assembles it — the outline, the numbered controls, the history, the
notes, the open tabs — and the one action it should be answered with.

```json
{
  "name": "discord-maps-search",
  "request": { "page": {...}, "outline": "...", "controls": [...], "history": [], "notes": [], "tabs": [], "now": "...", "eagerness": "eager" },
  "expect": { "kind": "fill", "target": 1, "valueIncludes": "Seven Shores Cafe" },
  "expectLocal": { "kind": "fill", "target": 1, "valueIncludes": "Seven Shores Cafe" }
}
```

- `expect` is what a model should answer. `pnpm eval --provider openai` judges
  against it.
- `expectLocal` is what the offline regex placeholder must answer with no
  network at all, which for most pages is `{ "kind": "none" }`. `pnpm eval`
  (provider `local`, the default) judges against it, so the placeholder's
  behaviour is pinned without a key.
- An expectation names a `kind` (or `"any"`), and may pin `target`,
  `valueIncludes` and `irreversible`. A negative uses `forbidTargets` and
  `forbidKinds`: the pay button, the delete link, a fill on a page with
  nothing to fill from.

`--eagerness conservative|balanced|eager` overrides the level in the fixture.
