import type { Eagerness } from './eagerness';
import { EAGERNESS, EAGERNESS_LEVELS } from './eagerness';
import type { NextAction, NextActionRequest } from './next-action';

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Every value that appears inside <examples> and nowhere else. The examples
 * are written out of invented places, people and hosts so that a model
 * copying one is obvious rather than plausible, and the orchestrator refuses
 * a fill that repeats one. The list lives beside the text it is drawn from so
 * the two cannot drift apart.
 */
export const EXAMPLE_VALUES: readonly string[] = [
  'Marigold Test Bistro',
  'Sample Grill',
  'Avery Example',
  '10 Sample Street',
  'Sample Street to Test Campus',
  'example-shop.test',
  'example-forum.test',
  'example-chat.test',
  'maps.example.test',
];

/**
 * The instructions are static and the examples come before anything from the
 * page, so every request on every site shares one prefix and the provider's
 * prompt cache hits. Only the last paragraph moves, and only with the
 * eagerness setting; each level's text is built once below.
 */
const ACTION_INSTRUCTIONS_HEAD = `You are Carat's next-action predictor, running inside a web browser. You see the current page as an outline in which every control the user could operate is numbered [n], notes about what the user read recently in other tabs, a log of what they just did, and the other tabs they have open. Predict the single action the user is most likely to take next, so they can accept it with one keypress.

Kinds:
- "click": press button, link, checkbox, radio, tab or menu item [n]. \`target\` is that number, \`value\` is "".
- "fill": type \`value\` into text field [n]. Only when the value is clearly implied by the page, the notes or the history (a search term, a quantity, a name the user just read, a reference number). Never invent personal data: names, addresses, emails, phone numbers, passwords, card numbers.
- "select": choose the option whose exact text is \`value\` in combobox or select [n].
- "scroll": read on, one viewport down. \`target\` is null, \`value\` is "". Only when there is more page below and reading is the step.
- "open": a destination that is not on this page. \`target\` is null; \`value\` names one of Carat's destinations and the thing to look up, as "maps:Marigold Test Bistro", "calendar:Dinner with Avery Example|2026-09-18T18:00|Marigold Test Bistro" or "gmail:avery@example-shop.test". Never write a URL: Carat builds it from the name. Those are shapes, not values; the thing to look up comes from the page, the notes or the history.
- "switch": bring one of the tabs in <tabs> forward. \`target\` is null, \`value\` is that tab's id as a string.

How to decide:
- <goal> is what the user is trying to get done across tabs; prefer the action that advances it; if the page cannot advance it, choose the page's own obvious next step.
- Follow the flow the history shows. Read it as a sequence: what was the user getting done, and what step comes next? A filled-in form wants its submit button; an opened dialog wants its primary action; a just-added cart item wants checkout.
- The focused control and the controls near it are the strongest signal. Required fields that are still empty come before submitting.
- <notes> often explain why the user came to this page. When the page is where they would act on a note, the next step is usually to put the note's details into the page (fill the matching field, select the matching option) or to press the control that acts on it.
- A place, a person or a plan named in <notes> with nowhere on this page to put it is an "open" instead; a destination the user already has open in <tabs> is a "switch".
- Only use numbers that appear in the outline. Never target a disabled control.
- Do not repeat the action the history shows the user just took, and never propose something they dismissed.
- Do not lead the user away from the task in progress: no logout, no footer links, no ads, no unrelated navigation, unless the history points there.
- When unsure, choose the control the user is most likely to want next on this page: usually the primary action near the focus, or the first item of the main content.

Output fields:
- target: the [n] of the control for fill, click and select; null for scroll, open, switch and none.
- kind: one of the kinds above.
- value: as described per kind; "" when the kind takes none.
- label: what the chip says, in the imperative, at most 60 characters: 'Open "Sample Street to Test Campus"', 'Fill Search Example Maps with "Marigold Test Bistro"', 'Click "Proceed to checkout"'.
- irreversible: true when the action sends, submits, posts, publishes, pays, buys, orders, deletes or otherwise cannot be undone. Carat then asks for a second keypress.
- confidence: 0 to 1, how likely this is the thing the user wants next.
- reason: one short clause, for the tooltip.`;

/**
 * The one paragraph the eagerness setting moves. A wrong chip costs one Esc
 * and a missing one costs the whole retype, so the default always answers;
 * the quieter levels are allowed the "none" kind when nothing clears the bar.
 */
const LAST_RULE: Record<Eagerness, string> = {
  eager: `You must always suggest an action. There is no "none" answer at this setting: even when the next step is uncertain, pick the single most likely one and say how sure you are.`,
  balanced: `Prefer to answer. Use \`kind: "none"\` (target null, value "", confidence 0) only when nothing on the page, in the notes or in the history points at a next step you would put at ${EAGERNESS.balanced.minConfidence} or better.`,
  conservative: `Answer only when you are sure. Use \`kind: "none"\` (target null, value "", confidence 0) whenever your best guess is under ${EAGERNESS.conservative.minConfidence}: here no suggestion beats a wrong one.`,
};

const shot = (action: NextAction): string => JSON.stringify(action);

const example = (request: string, action: NextAction): string => `<example>\n<request>\n${request}\n</request>\n<answer>\n${shot(action)}\n</answer>\n</example>`;

/**
 * The first line of the block, and the reason the block exists. The examples
 * used to be sent as real user and assistant turns, which put an invented
 * cafe in the transcript where the model reads its own history: it filled
 * that cafe into search boxes on sites that had never heard of it. They are
 * quoted inside the instructions now, and said to be quotations.
 */
const EXAMPLES_PREAMBLE = `These are illustrations of the format and the reasoning only. Nothing in them is about the current user. Never reuse a value from an example; a fill value must come from the current page's outline, the notes, the history, or the user's own typing.`;

/** A link in the body of what the user is reading. */
const EXAMPLE_LINK = example(
  `<notes>
(none)
</notes>
<history>
- 2m ago: visited example-forum.test/f/sample
- 15s ago: scrolled down
</history>
<tabs>
(none)
</tabs>
<page host="example-forum.test" path="/f/sample/thread/1">
Where should we eat? : sample
(0.8 screens above)
banner:
  [1] link "Example Forum" -> example-forum.test
  [2] searchbox "Search Example Forum"
main:
  heading(1) "Where should we eat?"
  text: Marigold Test Bistro was the pick last week. The menu is here:
  [3] link "Marigold Test Bistro menu" -> example-shop.test
  [4] button "Reply"
contentinfo:
  [5] link "Forum rules"
(1.6 more screens below; 9 controls not shown)
</page>`,
  {
    kind: 'click',
    target: 3,
    value: '',
    label: 'Open "Marigold Test Bistro menu"',
    irreversible: false,
    confidence: 0.72,
    reason: 'the post points at the menu the user is reading about',
  },
);

/** The card that answers a query the user just typed. */
const EXAMPLE_CARD = example(
  `<notes>
(none)
</notes>
<history>
- 50s ago: filled searchbox "Search Example Maps" with "marigold test bistro"
- 48s ago: clicked button "Search"
</history>
<tabs>
(none)
</tabs>
<page host="maps.example.test" path="/search/marigold+test+bistro">
marigold test bistro - Example Maps
search:
  [1] searchbox "Search Example Maps" = "marigold test bistro"
main:
  heading(1) "Results"
  group "Marigold Test Bistro":
    text: 4.6 (312) · Bistro · 10 Sample Street
    [2] button "Directions"
    [3] link "Order online" -> example-shop.test
  group "Sample Grill":
    text: 4.2 (88) · Steakhouse
    [4] button "Directions"
</page>`,
  {
    kind: 'click',
    target: 3,
    value: '',
    label: 'Click "Order online"',
    irreversible: false,
    confidence: 0.64,
    reason: 'the first result is the place the user searched for',
  },
);

/**
 * A note from another tab dropped into the field in front of the user. The
 * value is in the notes, the focused box asks for that kind of value, and the
 * answer says so: that pairing is what the example is for, not the place.
 */
const EXAMPLE_FILL = example(
  `<notes>
- Avery Example suggested dinner at Marigold Test Bistro on Friday at 6. (read on example-chat.test, 2m ago)
</notes>
<history>
- 2m ago: read example-chat.test/rooms/1/2
- 4s ago: opened a new tab on maps.example.test
</history>
<tabs>
- [tab 8] example-chat.test — Example Chat | #sample-room
</tabs>
<page host="maps.example.test" path="/">
Example Maps
search:
  >> FOCUSED [1] searchbox "Search Example Maps"
main:
  [2] button "Directions"
  [3] button "Saved"
</page>`,
  {
    kind: 'fill',
    target: 1,
    value: 'Marigold Test Bistro',
    label: 'Fill Search Example Maps with "Marigold Test Bistro"',
    irreversible: false,
    confidence: 0.91,
    reason: 'the note names the place and the focused box takes a place name',
  },
);

/**
 * Three shapes the engine has to get right, quoted rather than acted out. The
 * block sits in the system message, so nothing in it can be mistaken for
 * something this user did.
 */
export const EXAMPLES = `<examples>\n${EXAMPLES_PREAMBLE}\n\n${[EXAMPLE_LINK, EXAMPLE_CARD, EXAMPLE_FILL].join('\n\n')}\n</examples>`;

const ACTION_INSTRUCTIONS: Record<Eagerness, string> = Object.fromEntries(
  EAGERNESS_LEVELS.map((level) => [level, `${ACTION_INSTRUCTIONS_HEAD}\n\n${EXAMPLES}\n\n${LAST_RULE[level]}`]),
) as Record<Eagerness, string>;

/** The instructions for one eagerness level. The same string every call, byte for byte. */
export function actionInstructions(eagerness: Eagerness): string {
  return ACTION_INSTRUCTIONS[eagerness];
}

const BLOCK_EMPTY = '(none)';

function block(name: string, lines: readonly string[]): string {
  return `<${name}>\n${lines.length ? lines.join('\n') : BLOCK_EMPTY}\n</${name}>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * The head of the user turn: the goal, then notes, history and the open tabs,
 * and nothing that moves between two requests on the same page. A warm-up
 * call sends exactly this much and the real call repeats it byte for byte, so
 * the provider's prefix cache is already hot when the outline lands.
 *
 * `<goal>` is here rather than after the page because it frames everything
 * that follows, which does mean a goal that changes invalidates the prefix
 * cache once. That is the trade: a goal changes on the order of minutes, a
 * page on the order of seconds. A page with no goal behind it sends the same
 * bytes it always did, so the common case costs nothing.
 *
 * `now` is deliberately not in here: a clock in the prefix would break the
 * cache on every request. It goes after, with the page.
 */
export function renderPrefix(req: Pick<NextActionRequest, 'goal' | 'notes' | 'history' | 'tabs'>): string {
  const goal = req.goal?.trim();
  const notes = req.notes.map((n) => `- ${n}`);
  const history = req.history.map((h) => `- ${h}`);
  const tabs = req.tabs.map((t) => `- [tab ${t.id}] ${t.host} — ${t.title}`);
  return [
    ...(goal ? [block('goal', [goal])] : []),
    block('notes', notes),
    block('history', history),
    block('tabs', tabs),
  ].join('\n');
}

/**
 * The turn that changes per request: the shared prefix, then the clock, then
 * the page. The outline is last because it is the longest and the least
 * shared, so everything before it stays in the cached prefix.
 */
export function renderRequest(req: NextActionRequest): string {
  return [
    renderPrefix(req),
    `<now>${req.now}</now>`,
    // No scroll attribute: the outline's own first and last lines say where
    // the page is, and they measure what was described rather than the
    // document, so two numbers cannot disagree in front of the model.
    `<page host="${escapeAttr(req.page.host)}" path="${escapeAttr(req.page.path)}">`,
    req.page.title,
    req.outline,
    '</page>',
  ].join('\n');
}

/**
 * One request for one action: the static instructions with the examples
 * quoted inside them, then the page. Deterministic: the same request at the
 * same level produces the same bytes, which is what makes the prefix
 * cacheable and the eval stable.
 */
export function buildNextActionMessages(req: NextActionRequest): ChatMessage[] {
  return [
    { role: 'system', content: actionInstructions(req.eagerness) },
    { role: 'user', content: renderRequest(req) },
  ];
}

/**
 * What a warm-up call puts where the outline goes. Dumb on purpose: the point
 * is the prefix in front of it, not the answer, which is thrown away.
 */
export const WARMUP_OUTLINE = 'main: (warming the cache; the page has not been read yet)';

/**
 * The same request with the outline replaced by one placeholder line. Sent
 * with a one-token cap on navigation, so the static instructions, the
 * examples, the notes, the history and the tabs are in the provider's prefix
 * cache before the user's page has finished rendering.
 */
export function buildWarmupMessages(req: NextActionRequest): ChatMessage[] {
  return buildNextActionMessages({ ...req, outline: WARMUP_OUTLINE, controls: [] });
}

// Text-only output so the reading drops straight into the notes pipeline. The
// user turn names the tab and carries `now`, so relative dates in the picture
// can be pinned down here, once, instead of by every later request.
export const TRANSCRIBE_PROMPT = [
  'You read a screenshot of a browser tab into plain text for an assistant that later fills forms and plans from it. The user message names the tab and gives `now`, the current time as ISO 8601 with offset.',
  '',
  'Write two parts, nothing else:',
  '1. The text visible in the image, in reading order, one line per block. Copy names, places, addresses, dates, times, emails, phone numbers and codes exactly as written.',
  '2. A line `Facts:` followed by one fact per line. Include a line only when the image supports it:',
  '- Absolute dates and times, resolved against `now` from relative or partial ones: "3 days ago" becomes the date, "Fri 7pm" becomes the coming Friday at 19:00, "yesterday at noon" becomes a date and 12:00. Write them as ISO 8601 with offset, or a date alone when no time is given.',
  '- Places and venues.',
  '- Street addresses.',
  '- People and handles.',
  '- Prices.',
  '- One line per image in the screenshot that carries information a plan would need (a venue sign, an event poster, a menu, a map pin, a ticket), stated as the fact it shows, not as a picture: "Poster: Night Market, Sat 2026-09-26 18:00 to 23:00, Waterloo Public Square", not "a colourful poster".',
  '',
  'No layout, no colours, no commentary, no headings of your own beyond `Facts:`. Leave `Facts:` out entirely when there is nothing to put under it.',
  'If there is no readable text and nothing informative in the image, reply with an empty string.',
].join('\n');

/**
 * The notes call. A page the user has just left, distilled into the few facts
 * they are likely to act on somewhere else. Short output, no reasoning: it
 * runs on every tab switch.
 */
export const DISTILL_PROMPT = [
  'You help a browser assistant remember what the user just read. You get the visible text of a page they were looking at before they switched away from it.',
  '',
  'Extract the facts they are likely to act on soon, possibly on a different website: requests or plans addressed to them, things they agreed to, and the concrete details needed to act on them (names, places, dates and times, amounts, quantities, product or item names, reference numbers, addresses).',
  '',
  '- Write each note as one short, self-contained sentence that still makes sense later on another site: say who or what it concerns and include the specifics.',
  '- When the page shows when something was written and a date is relative ("tomorrow", "next Friday"), keep the wording and add the absolute date if the page lets you work it out.',
  '- Ignore navigation, menus, ads, boilerplate, and anything the user is unlikely to act on.',
  '- Never include passwords, card numbers or other secrets.',
  '- At most 5 notes. Return an empty list when nothing on the page is actionable.',
].join('\n');

export const DISTILL_JSON_SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'array', items: { type: 'string' } } },
  required: ['notes'],
  additionalProperties: false,
} as const;

export const DISTILL_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'carat_notes', strict: true, schema: DISTILL_JSON_SCHEMA },
} as const;

/** The distill call's user turn: the page's host, title and text. */
export function distillMessages(text: string, host: string, title = ''): ChatMessage[] {
  return [
    { role: 'system', content: DISTILL_PROMPT },
    { role: 'user', content: `<page host="${escapeAttr(host)}" title="${escapeAttr(title)}">\n${text}\n</page>` },
  ];
}
