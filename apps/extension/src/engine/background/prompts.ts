/**
 * Request bodies for the OpenAI Responses API.
 *
 * Order matters for prompt caching, which matches on a shared prefix: static
 * instructions and few-shots first, then the page outline (stable while the
 * user types), and the typed text last.
 */

import type { FieldInfo } from "../shared/protocol";
import type { Settings } from "../shared/settings";

type InputMessage = { role: "user" | "assistant"; content: string };

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: InputMessage[];
  max_output_tokens: number;
  stream: boolean;
  store: boolean;
  reasoning?: { effort: string };
  service_tier?: string;
  prompt_cache_key?: string;
  text?: { format: object };
}

/** Short stable hash (FNV-1a) for prompt_cache_key. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(kind: string, url: string): string {
  try {
    const u = new URL(url);
    return `carat-${kind}-${hash(u.origin + u.pathname)}`;
  } catch {
    return `carat-${kind}`;
  }
}

function common(settings: Settings, model: string, url: string, kind: string) {
  return {
    model,
    stream: true,
    store: false,
    // Autocomplete is a latency path: no thinking on a few dozen output tokens.
    reasoning: { effort: "none" },
    prompt_cache_key: cacheKey(kind, url),
    ...(settings.serviceTier !== "auto" ? { service_tier: settings.serviceTier } : {}),
  };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function fieldTag(field: FieldInfo, axName: string | undefined, role: string | undefined): string {
  const attrs: string[] = [
    `role="${role ?? (field.multiline ? "textbox" : field.inputType === "search" ? "searchbox" : "textbox")}"`,
    `name="${escapeAttr(axName || field.name)}"`,
    `type="${field.inputType}"`,
    `multiline="${field.multiline}"`,
  ];
  if (field.placeholder) attrs.push(`placeholder="${escapeAttr(field.placeholder)}"`);
  if (field.maxLength != null) attrs.push(`maxlength="${field.maxLength}"`);
  return `<field ${attrs.join(" ")}/>`;
}

// ---------------------------------------------------------------------------
// Ghost text

export const TEXT_INSTRUCTIONS = `You are Carat, an inline autocomplete engine inside a web browser. The user is typing into a text field on a web page. Predict what they will type next, continuing exactly from the end of <typed>.

Rules:
- Output ONLY the continuation text. No quotes, no preamble, no explanation. Never repeat anything already in <typed>.
- If <typed> ends mid-word, finish that word first (no leading space). If it ends with a space, do not start with another space.
- Ground the suggestion in the page: names, numbers, products, dates and facts that appear in <page> are fair game. Do not invent specifics that are not there.
- <notes> are facts from pages the user read recently in other tabs. When the field is clearly asking for one of them, use it.
- Match what the field is for and the tone of the page: a search box wants a query, a subject line wants a short title, a message body wants natural prose in the user's own voice.
- Single-line fields: one line, never a newline. Multi-line fields: at most one sentence or clause past the caret.
- Short and likely beats long and speculative. If there is no confident continuation, output nothing at all.`;

const TEXT_SHOTS: InputMessage[] = [
  {
    role: "user",
    content: `<page>
PAGE: Hiking Boots | TrailGear (https://trailgear.example/boots)
navigation "Main":
  link "Men"
  link "Women"
search:
  >> FOCUSED searchbox "Search TrailGear"
main:
  heading(1) "Hiking Boots"
  text: Waterproof · Gore-Tex · Wide fit available
</page>
<notes>
(none)
</notes>
<field role="searchbox" name="Search TrailGear" type="search" multiline="false"/>
<typed>waterproof hiking boots wi</typed>`,
  },
  { role: "assistant", content: "de fit" },
  {
    role: "user",
    content: `<page>
PAGE: Inbox (3) — Mail (https://mail.example.com/compose)
dialog "New message":
  textbox "To" = "dana.lee@acme.com"
  >> FOCUSED textbox "Subject"
  textbox "Message body" = "Hi Dana, attaching the Q3 vendor invoices you asked for on Friday."
</page>
<notes>
(none)
</notes>
<field role="textbox" name="Subject" type="text" multiline="false"/>
<typed>Q3 vendor </typed>`,
  },
  { role: "assistant", content: "invoices" },
  {
    role: "user",
    content: `<page>
PAGE: Ticket #4821 — Support Desk (https://desk.example.com/t/4821)
main:
  heading(1) "Printer offline after firmware update"
  region "Conversation":
    text: Customer · 2 days ago
    text: Since the 3.2 firmware update my HP M452 shows as offline after every reboot. Three machines on the same subnet are affected.
    text: Customer · 1 hour ago
    text: It says 3.2.0.4711. The other two are on the same build.
  form "Reply":
    combobox "Status" = "Awaiting customer"
    >> FOCUSED textbox "Reply body"
    button "Send reply"
</page>
<notes>
(none)
</notes>
<field role="textbox" name="Reply body" type="textarea" multiline="true"/>
<typed>Thanks for confirming. Since all three are on 3.2.0.4711, </typed>`,
  },
  {
    role: "assistant",
    content: "could you try rolling one of them back to 3.1 and let me know if it stays online after a reboot?",
  },
];

export function buildTextRequest(opts: {
  settings: Settings;
  url: string;
  outline: string;
  notes: string;
  field: FieldInfo;
  axName?: string;
  axRole?: string;
}): ResponsesRequest {
  const { settings, url, outline, field } = opts;
  const content = `<page>
${outline}
</page>
<notes>
${opts.notes}
</notes>
${fieldTag(field, opts.axName, opts.axRole)}
<typed>${field.typed}</typed>`;
  return {
    ...common(settings, settings.textModel, url, "text"),
    instructions: TEXT_INSTRUCTIONS,
    input: [...TEXT_SHOTS, { role: "user", content }],
    max_output_tokens: field.multiline ? 48 : 24,
  };
}

// ---------------------------------------------------------------------------
// Next action

export const ACTION_INSTRUCTIONS = `You are Carat's next-action predictor, running inside a web browser. You see the current page as an accessibility outline in which every control the user could operate is numbered [n], notes about what the user recently read on other pages, and a log of what the user just did. Predict the single action the user is most likely to take next, so they can accept it with one keypress.

Kinds:
- "click": press button / link / checkbox / radio / tab / menu item [n].
- "fill": move to text field [n] and type "value". Only when the value is clearly implied by the page, the notes or the history (e.g. a quantity, a search term, a reference number the user just read). Never invent personal data such as names, addresses, emails, phone numbers, passwords or card numbers.
- "select": choose the option whose exact text is "value" in combobox [n].
- "submit": press Enter in text field [n]. Search boxes and many forms submit this way, and a search button often does nothing.
- "switch": go to another open tab, given as its [Tn].
- "open": put "value" in the address bar of this tab: a URL goes there, anything else is searched with the user's default search engine.
- "scroll": move one screen down, when nothing on the visible page is worth acting on. target is 0 and value is "". This is the last resort, not a habit.

You must always suggest an action. There is no "nothing" answer: even when the next step is uncertain, pick the single most likely one.

How to decide:
- Follow the flow the user is in. Read the history as a sequence: what were they trying to get done, and what step comes next? A filled-in form wants its submit button; an opened dialog wants its primary action; a just-added cart item wants checkout.
- The page usually holds the next step. Only reach for a tab, a search or going back when the page plainly cannot do what comes next: the answer is in another tab, the user is done here, or they need something the site does not have.
- For "switch", target is the tab's [Tn] number and value is "". For "open", target is 0 and value is what goes in the address bar.
- If the user has highlighted text, the next step is almost always about that text: open the site or thing it names (kind "open" with the URL if it names one, otherwise a search for it), put it into the focused field, or search the page's own search box for it. Do not scroll past a highlight.
- Choose "scroll" only when the outline says the page continues below the viewport and nothing in view is the next step. Scrolling is what to do when the visible page has nothing to act on; a highlight, a focused field, a note that matches something on screen, or a link the user is likely to want all come first.
- <notes> often explain why the user came to this page: if the page is where they would act on a note, the next step is usually to put the note's details into the page (fill the matching field, select the matching option) or to press the control that acts on it.
- The focused control and the controls near it are the strongest signal. "(required)" fields that are still empty come before submitting.
- Only use numbers that appear in the outline. Never target a disabled control.
- Do not repeat the action the user just took, and never propose something the history shows they dismissed.
- Do not lead the user away from a task in progress (logout, footer links, ads, unrelated navigation) unless the history points there.
- When unsure, choose the control the user is most likely to want next on this page (usually the primary action near the focus, or the first item of the main content).

Output fields:
- target: the [n] of the control, or the [Tn] number for "switch". 0 for "open".
- kind: one of the kinds above.
- value: the text to type or the option to select; "" for click. Keep it short, at most about 300 characters: for long free-text fields (descriptions, messages, essays) give only the opening sentence or two, and the user continues from there with autocomplete.
- label: 1 to 4 words for the Tab hint, e.g. "Send reply", "Checkout", "Status: Resolved", "Quantity 2".
- irreversible: true if the action sends, submits, posts, publishes, pays, buys, deletes, or otherwise cannot be undone.`;

/** Ours: the highlight goes directly under the PAGE line, where the model reads the page from. */
export const MAX_SELECTION = 300;

export function withSelection(outline: string, selection: string | undefined): string {
  const text = selection?.replace(/\s+/g, " ").trim().slice(0, MAX_SELECTION) ?? "";
  if (!text) return outline;
  const cut = outline.indexOf("\n");
  const head = cut === -1 ? outline : outline.slice(0, cut);
  const rest = cut === -1 ? "" : outline.slice(cut);
  return `${head}\n<selection>${text}</selection>${rest}`;
}

export const ACTION_SCHEMA = {
  type: "object",
  // kind and target first: the ring can move before the rest has streamed, and
  // kind says whether that number is a page control or a tab.
  properties: {
    kind: { type: "string", enum: ["click", "fill", "select", "submit", "switch", "open", "scroll"] },
    target: { type: "integer" },
    value: { type: "string" },
    label: { type: "string" },
    irreversible: { type: "boolean" },
  },
  required: ["kind", "target", "value", "label", "irreversible"],
  additionalProperties: false,
};

const ACTION_SHOTS: InputMessage[] = [
  {
    role: "user",
    content: `<page>
PAGE: Expense report — Ledger (https://ledger.example/expenses/new)
main:
  heading(1) "New expense"
  form:
    [1] textbox "Merchant" = "Northwind Outfitters"
    [2] textbox "Amount"
    [3] button "Save"
</page>
<browser>
other open tabs:
  [T1] tab "Re: Your order NW-55821 — Mail" (mail.example.com/u/0)
  [T2] tab "Team calendar" (calendar.example.com)
you can also: open a URL or run a search in this tab
</browser>
<notes>
(none)
</notes>
<history>
- 20s ago: typed into textbox "Merchant": "Northwind Outfitters" [on ledger.example/expenses/new]
</history>`,
  },
  {
    role: "assistant",
    content: `{"kind":"switch","target":1,"value":"","label":"Order email","irreversible":false}`,
  },
  {
    role: "user",
    content: `<page>
PAGE: Start a return — Northwind Outfitters (https://northwind.example/returns/new)
main:
  heading(1) "Start a return"
  form "Return request":
    [1] textbox "Order number" (required)
    [2] textbox "Email used for the order" (required)
    [3] combobox "Reason" = "Choose a reason"
      option "Wrong size"
      option "Arrived damaged"
      option "Changed my mind"
    [4] button "Continue"
</page>
<notes>
- Northwind order NW-55821 (trail jacket) arrived with a torn sleeve; support said to open a return and pick "damaged" as the reason. (read 3m ago on mail.example.com, "Re: Your order NW-55821")
</notes>
<history>
- 40s ago: opened northwind.example/returns/new (typed in the address bar)
</history>`,
  },
  {
    role: "assistant",
    content: `{"kind":"fill","target":1,"value":"NW-55821","label":"Order number","irreversible":false}`,
  },
  {
    role: "user",
    content: `<page>
PAGE: Your cart — ShopCo (https://shop.example/cart)
banner:
  [1] link "ShopCo home"
  [2] searchbox "Search"
main:
  heading(1) "Your cart (1 item)"
  text: Ceramic pour-over set · $34.00
  [3] spinbutton "Quantity" = "1"
  [4] button "Remove"
  text: Subtotal $34.00
  [5] button "Proceed to checkout"
contentinfo:
  [6] link "Careers"
</page>
<notes>
(none)
</notes>
<history>
- 12s ago: clicked button "Add to cart" [on shop.example/p/pour-over-set]
- 3s ago: clicked link "Cart (1)" [on shop.example/p/pour-over-set]
</history>`,
  },
  {
    role: "assistant",
    content: `{"kind":"click","target":5,"value":"","label":"Checkout","irreversible":false}`,
  },
  {
    role: "user",
    content: `<page>
PAGE: Ticket #4821 — Support Desk (https://desk.example.com/t/4821)
main:
  heading(1) "Printer offline after firmware update"
  form "Reply":
    [1] combobox "Status" = "Awaiting customer"
      option "Open"
      option "Awaiting customer"
      option "Resolved"
    >> FOCUSED [2] textbox "Reply body" = "Glad the rollback fixed it! I'll close this ticket now, just reply here if it comes back."
    [3] button "Send reply"
</page>
<notes>
(none)
</notes>
<history>
- 40s ago: typed into textbox "Reply body"
</history>`,
  },
  {
    role: "assistant",
    content: `{"kind":"select","target":1,"value":"Resolved","label":"Status: Resolved","irreversible":false}`,
  },
  {
    role: "user",
    content: `<page>
PAGE: Which clubs are actually active? : r/uwaterloo (https://reddit.example/r/uwaterloo/comments/1f2)
<selection>The wusa website has the list of active clubs</selection>
main:
  heading(1) "Which clubs are actually active?"
  text: Half the clubs on the sign-up sheet have not met in a year.
  article:
    text: The wusa website has the list of active clubs, updated each term.
    [1] link "reply"
    [2] link "share"
(the page continues below the viewport)
</page>
<browser>
no other tabs are open
you can also: open a URL or run a search in this tab
</browser>
<notes>
(none)
</notes>
<history>
- 8s ago: followed a link to reddit.example/r/uwaterloo/comments/1f2
</history>`,
  },
  {
    role: "assistant",
    content: `{"kind":"open","target":0,"value":"wusa active clubs list","label":"Search wusa clubs","irreversible":false}`,
  },
  {
    role: "user",
    content: `<page>
PAGE: News — Daily Planet (https://planet.example/)
banner:
  [1] link "Home"
  [2] link "World"
  [3] link "Sports"
main:
  heading(2) "City council approves new transit budget"
  [4] link "Read more"
  heading(2) "Local team wins opener"
  [5] link "Read more"
</page>
<notes>
(none)
</notes>
<history>
(nothing yet)
</history>`,
  },
  {
    role: "assistant",
    content: `{"kind":"click","target":4,"value":"","label":"Read top story","irreversible":false}`,
  },
];

export function buildActionRequest(opts: {
  settings: Settings;
  url: string;
  outline: string;
  notes: string;
  history: string;
  browser: string;
  /** Ours: the page continues past the bottom of the viewport, so "scroll" is available. */
  below?: boolean;
  /** Ours: what the user has highlighted, which is usually what the next step is about. */
  selection?: string;
}): ResponsesRequest {
  const { settings, url, outline, notes, history, browser } = opts;
  const content = `<page>
${withSelection(outline, opts.selection)}
${opts.below ? "(the page continues below the viewport)" : "(nothing below the viewport)"}
</page>
<browser>
${browser}
</browser>
<notes>
${notes}
</notes>
<history>
${history}
</history>`;
  return {
    ...common(settings, settings.actionModel, url, "action"),
    instructions: ACTION_INSTRUCTIONS,
    input: [...ACTION_SHOTS, { role: "user", content }],
    // Clicks need ~30 tokens; a fill value can need more. Only generated tokens cost anything.
    max_output_tokens: 400,
    text: { format: { type: "json_schema", name: "next_action", strict: true, schema: ACTION_SCHEMA } },
  };
}

// ---------------------------------------------------------------------------
// Tasks: an instruction the user typed, carried out step by step

export const TASK_INSTRUCTIONS = `You are Carat, carrying out one instruction for the user inside their browser. You see the current page as an accessibility outline where every control is numbered [n], notes about what the user recently read or heard, a log of what they did, and the steps you have already taken for this instruction.

Decide the SINGLE next step. You will see the page again after it happens, so never plan ahead in one answer: do one thing, then look.

Kinds:
- "click": press button / link / checkbox / radio / tab / menu item [n].
- "fill": type "value" into text field [n].
- "select": choose the option whose exact text is "value" in combobox [n].
- "submit": press Enter in text field [n]. Search boxes and many forms submit this way, and a search button often does nothing.
- "switch": go to another open tab, given as its [Tn].
- "open": put "value" in the address bar of this tab: a URL goes there, anything else is searched with the user's default search engine.
- "wait": do nothing and look at the page again, when it is still loading or updating and there is nothing to act on yet. Working out the next step already takes a moment, so this is just another look.
- "ask": you cannot continue without something only the user knows (a value that is not on the page or in the notes, or a choice between options that are genuinely equivalent). Put the question in "message".
- "done": the instruction has been carried out, or nothing more can be done. Put a one-sentence summary in "message".

How to decide:
- Work from the page as it is now. If your last step did not do what you expected (a menu did not open, a validation error appeared), react to that instead of repeating it.
- A step marked "nothing changed" did not work: never repeat it. Try another way — press Enter in the field with "submit" instead of clicking a search button, or pick a different control.
- Prefer the shortest route to what the user asked for. Do not tidy up, explore, or do anything they did not ask for.
- Only use numbers that appear in the outline, and never a disabled control. Tab numbers come from <browser>.
- Use the page first. "open" and "switch" are for when the instruction needs something this page does not have: a search, a different site, or a tab already holding the answer. The user confirms leaving the current site.
- Fill values must come from the instruction, the page, the notes or the history. Never invent personal data (names, addresses, emails, phone numbers, card numbers).
- Answer "done" only when the whole instruction has been carried out. A flow with more of itself left (a return leg to choose, passenger details, a review page, a final confirmation only the user can give) is not finished: carry on to the next part. If all that remains is something the user must do themselves, say so in the "done" message.
- Stay on the task the user gave you. Never log out, delete anything they did not mention, or navigate away from the site.

Output fields:
- why: a short phrase (under 10 words) saying why this step, shown to the user.
- kind, target, value: as above. target is the [n] of a control, the [Tn] number for "switch", or 0 for "open", "wait", "ask" and "done".
- label: 1 to 4 words naming the control, e.g. "Send reply", "Priority".
- irreversible: true if this step sends, submits, posts, publishes, pays, buys, deletes or otherwise cannot be undone. The user confirms those by hand.
- message: the question for "ask", the summary for "done", otherwise "".`;

export const TASK_SCHEMA = {
  type: "object",
  properties: {
    why: { type: "string" },
    kind: { type: "string", enum: ["click", "fill", "select", "submit", "switch", "open", "wait", "ask", "done"] },
    target: { type: "integer" },
    value: { type: "string" },
    label: { type: "string" },
    irreversible: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["why", "kind", "target", "value", "label", "irreversible", "message"],
  additionalProperties: false,
};

export function buildTaskRequest(opts: {
  settings: Settings;
  url: string;
  goal: string;
  outline: string;
  notes: string;
  history: string;
  /** What has been done so far in this task, oldest first. */
  steps: string[];
  browser: string;
}): ResponsesRequest {
  const { settings, url, goal, outline, notes, history, steps, browser } = opts;
  const content = `<instruction>
${goal}
</instruction>
<page>
${outline}
</page>
<browser>
${browser}
</browser>
<notes>
${notes}
</notes>
<history>
${history}
</history>
<steps_taken>
${steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(none yet)"}
</steps_taken>
What is the next step?`;
  return {
    ...common(settings, settings.actionModel, url, "task"),
    instructions: TASK_INSTRUCTIONS,
    input: [{ role: "user", content }],
    max_output_tokens: 400,
    text: { format: { type: "json_schema", name: "next_step", strict: true, schema: TASK_SCHEMA } },
  };
}
