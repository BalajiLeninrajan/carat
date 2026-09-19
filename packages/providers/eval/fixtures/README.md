Each fixture is `{ name, request: SuggestRequest, expect: Expectation[] }`. A fill expectation is `{ fieldId, valueIncludes }`; an action expectation is `{ intent, valueIncludes, whenStartsWith? }`; an interaction expectation is `{ elementId, verb, valueIncludes }`. An empty `expect` means the provider must return nothing.

`request.context` holds text from other tabs and is the only source for fills and interactions. `request.own` holds text from the requesting tab and is the only source for actions. `request.elements` lists the page's interactive controls; `request.filled` lists the context ids behind fields carat itself just filled, which is the only thing that justifies clicking a Save-like button.

Two optional keys make a fixture depend on the eagerness level the eval runs at (`--eagerness`, default `eager`):

- `expectAt: { eager: [...] }` replaces `expect` at that level. The `eager-*` fixtures are negatives below eager and positives at eager; `neg-same-tab` becomes a positive at eager because another tab on the page's own site counts as context there.
- `weakOkAt: ["eager"]` lets a negative pass at that level when every chip it produced sits under the next stricter level's floor. That is the documented cost of eager: a weak chip on `neg-news-search` and `neg-recipe-comment`, one Esc each. The runner prints these as WEAK.
