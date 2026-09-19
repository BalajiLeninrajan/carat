Each fixture is `{ name, request: SuggestRequest, expect: Expectation[] }`. A fill expectation is `{ fieldId, valueIncludes }`; an action expectation is `{ intent, valueIncludes, whenStartsWith? }`. An empty `expect` means the provider must return nothing.

`request.context` holds text from other tabs and is the only source for fills. `request.own` holds text from the requesting tab and is the only source for actions.
