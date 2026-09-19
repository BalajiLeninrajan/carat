import {
  IRREVERSIBLE,
  type ActionKind,
  type FieldInfo,
  type PredictedAction,
} from "../shared/types.js";
import { scrubValue } from "../shared/redact.js";

/**
 * The few-shot block is doing most of the work here. Without it the model
 * writes a helpful paragraph about what you could type; with it, it emits the
 * four words that belong after the caret and stops.
 */
export const SYSTEM_PROMPT = `You are Carat, an inline autocomplete engine for text fields in a web browser. You are given a semantic outline of the page (from its accessibility tree), a description of the field the user is typing in, and the text they have typed so far.

Output ONLY the characters that should appear immediately after what the user has typed. Nothing else.

Rules:
- Never repeat any part of the typed text. Your output is appended verbatim.
- No quotes, no markdown, no labels, no explanation, no trailing commentary.
- Spacing is yours to get right, because your output is concatenated with no adjustment:
  - typed text ends mid-word -> continue that word directly, no leading space.
  - typed text ends with a complete word and no trailing space -> START WITH A SINGLE SPACE.
  - typed text already ends with a space -> do not add another.
- Write in the language and register of the surrounding page.
- Single-line fields: one line, at most about twelve words.
- Multi-line fields: at most two sentences.
- Use concrete details from the page outline (names, ticket numbers, product names) rather than generic filler.
- If there is no genuinely useful continuation, output nothing at all.

EXAMPLES

<page>PAGE: Amazon (https://www.amazon.com)
  search "Search Amazon":
    >> FOCUSED searchbox "Search Amazon"</page>
<field role="searchbox" multiline="false"/>
<typed>wireless mechanical key</typed>
-> board with hot-swappable switches

<page>PAGE: New issue - acme/runtime (https://github.com/acme/runtime/issues/new)
  heading(1): New issue
  form "New issue":
    >> FOCUSED textbox "Title"
    textbox "Comment" = "Calling run() twice leaks a worker thread. Repro attached."</page>
<field role="textbox" multiline="false"/>
<typed>run() leaks a </typed>
-> worker thread when called twice

<page>PAGE: Ticket #4821 - Support Desk (https://desk.example.com/t/4821)
  heading(1): Printer offline after firmware update
  region "Conversation":
    text: Customer: Since the 3.2 update my M452 shows offline on every reboot.
  form "Reply":
    combobox "Status" = Pending
    >> FOCUSED textbox "Reply body"</page>
<field role="textbox" multiline="true"/>
<typed>Thanks for the details. Could you</typed>
->  confirm whether the M452 is on firmware 3.2.1 or later? Rolling back to 3.1.9 clears the offline state on most units.
(note the leading space above: "you" is a complete word, so the continuation must supply the space that separates them)

<page>PAGE: Settings (https://app.example.com/settings)
  form "Profile":
    >> FOCUSED textbox "Display name"</page>
<field role="textbox" multiline="false"/>
<typed></typed>
->

END EXAMPLES`;

export interface PromptParts {
  system: string;
  user: string;
}

export function buildPrompt(field: FieldInfo, outline: string): PromptParts {
  const attrs = [
    `role="${field.role}"`,
    `multiline="${field.multiline}"`,
  ];
  if (field.name) attrs.push(`name=${JSON.stringify(field.name)}`);
  if (field.placeholder) attrs.push(`placeholder=${JSON.stringify(field.placeholder)}`);
  if (field.maxLength && field.maxLength > 0) attrs.push(`maxlength="${field.maxLength}"`);

  const user = [
    `<page>${outline}</page>`,
    `<field ${attrs.join(" ")}/>`,
    `<typed>${scrubValue(field.typed)}</typed>`,
  ].join("\n");

  return { system: SYSTEM_PROMPT, user };
}

/**
 * The model occasionally ignores the "no preamble" rule, or re-emits the tail
 * of what the user typed. Cheap to repair here, expensive to notice in a demo.
 */
export function sanitizeCompletion(raw: string, field: FieldInfo): string {
  let text = raw;
  if (!text) return "";

  // Strip a wrapping pair of quotes the model sometimes adds.
  const trimmed = text.trim();
  if (trimmed.length > 1) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "“" && last === "”")) {
      text = trimmed.slice(1, -1);
    }
  }

  // Drop an echoed suffix of the typed text ("...could you" -> "could you ...").
  const typed = field.typed;
  const maxOverlap = Math.min(typed.length, text.length, 60);
  for (let n = maxOverlap; n >= 4; n--) {
    if (typed.slice(-n).toLowerCase() === text.slice(0, n).toLowerCase()) {
      text = text.slice(n);
      break;
    }
  }

  if (!field.multiline) {
    text = text.split(/[\r\n]/)[0];
  } else {
    text = text.replace(/\n{3,}/g, "\n\n");
  }

  // Never double a space the user already typed.
  if (/\s$/.test(typed)) text = text.replace(/^[ \t]+/, "");

  if (field.maxLength && field.maxLength > 0) {
    const room = field.maxLength - typed.length - field.trailing.length;
    if (room <= 0) return "";
    if (text.length > room) text = text.slice(0, room);
  }

  return text;
}

// ------------------------------------------------------------------ actions

/**
 * Next-action prediction. Same page outline, but every control carries an
 * [n] and the model answers with one of them. It is told outright that "none"
 * beats a guess: a wrong highlight costs the user more than no highlight.
 */
export const ACTION_SYSTEM_PROMPT = `You are Carat, predicting the single next action a user will take on a web page. You see the page's accessibility outline, where every control the user can act on is numbered [n], and a short log of what the user just did.

Respond with exactly one JSON object and nothing else:
{"action": "click" | "focus" | "select" | "none", "target": <n>, "value": "<string>", "label": "<2-5 words>", "confidence": <0 to 1>, "irreversible": <true|false>}

- click: press a button, link, checkbox, radio, tab or menu item.
- focus: move into a text field. Put the text you expect them to enter in "value", or "" if you cannot say.
- select: choose an option in a dropdown. "value" is the option's text exactly as listed under it.
- none: nothing is predictable enough. Prefer none to a guess. Use target 0.
- "label" is what the user sees beside the highlighted control, e.g. "Send reply", "Status: Resolved", "Next page".
- "confidence" is your honest probability that this is the very next thing they do - not whether it would be sensible.
- "irreversible" is true when the action sends, submits, pays, deletes, publishes or otherwise cannot be taken back.
- Follow the task, not the layout: what did they just finish, and what does the page expect next? A form they just filled is usually submitted next; a field they just left is not the next action.
- Only pick a [n] that appears in the outline.

EXAMPLES

<page>PAGE: Ticket #88 - Helpdesk
  [1] link "All tickets"
  form "Reply":
    [2] combobox "Status" = Open
      option "Open"
      option "Resolved"
    >> FOCUSED [3] textbox "Reply" = Thanks for confirming the fix worked - I'll close this out now.
    [4] button "Send"</page>
<recent>
- 20s ago: opened "Ticket #88 - Helpdesk"
- just now: typed in textbox "Reply"
</recent>
-> {"action":"select","target":2,"value":"Resolved","label":"Status: Resolved","confidence":0.7,"irreversible":false}

<page>PAGE: Checkout - Shipping
  form "Shipping address":
    [1] textbox "Full name" = Dana Reyes
    [2] textbox "Street" = 12 Birch Lane
    [3] textbox "City" = Portland
    [4] textbox "Postcode"
    [5] button "Continue to payment"</page>
<recent>
- just now: typed in textbox "City"
</recent>
-> {"action":"focus","target":4,"value":"","label":"Postcode","confidence":0.85,"irreversible":false}

<page>PAGE: Inbox (3) - Mail
  [1] button "Compose"
  list "Messages":
    [2] link "Quarterly numbers - Priya"
    [3] link "Lunch Thursday? - Sam"</page>
<recent>
- 4s ago: opened "Inbox (3) - Mail"
</recent>
-> {"action":"none","target":0,"value":"","label":"","confidence":0.2,"irreversible":false}

END EXAMPLES`;

/** Strict JSON schema for APIs that support structured output. */
export const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["click", "focus", "select", "none"] },
    target: { type: "integer" },
    value: { type: "string" },
    label: { type: "string" },
    confidence: { type: "number" },
    irreversible: { type: "boolean" },
  },
  required: ["action", "target", "value", "label", "confidence", "irreversible"],
} as const;

export interface HistoryEntry {
  at: number;
  entry: string;
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 3) return "just now";
  if (s < 90) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

export function buildActionPrompt(
  outline: string,
  history: HistoryEntry[],
  now = Date.now(),
): PromptParts {
  const recent = history.length
    ? history.map((h) => `- ${ago(now - h.at)}: ${h.entry}`).join("\n")
    : "- (nothing yet)";
  return {
    system: ACTION_SYSTEM_PROMPT,
    user: `<page>${outline}</page>\n<recent>\n${recent}\n</recent>`,
  };
}

/** The minimum parseAction needs to know about each numbered control. */
export interface CandidateInfo {
  n: number;
  role: string;
  name: string;
}

const FOCUSABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const SELECTABLE_ROLES = new Set(["combobox", "listbox"]);

/**
 * Turn the model's reply into an action we are willing to show, or null.
 * Nothing it says is taken on trust: the target has to be a real candidate,
 * the kind has to make sense for that control's role, and irreversibility is
 * the union of the model's opinion and our own pattern match.
 */
export function parseAction(raw: string, candidates: CandidateInfo[]): PredictedAction | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }

  const action = String(data.action ?? "none");
  if (action === "none") return null;
  if (action !== "click" && action !== "focus" && action !== "select") return null;

  const target = Number(data.target);
  const candidate = candidates.find((c) => c.n === target);
  if (!candidate) return null;

  // Reconcile the verb with what the control actually is.
  let kind: ActionKind = action;
  if (kind === "select" && !SELECTABLE_ROLES.has(candidate.role)) return null;
  if (kind === "click" && FOCUSABLE_ROLES.has(candidate.role) && candidate.role !== "combobox") {
    kind = "focus";
  }
  if (kind === "focus" && !FOCUSABLE_ROLES.has(candidate.role)) kind = "click";

  const value = typeof data.value === "string" ? scrubValue(data.value).slice(0, 300) : "";
  if (kind === "select" && !value) return null;

  let label = typeof data.label === "string" ? data.label.replace(/\s+/g, " ").trim() : "";
  if (!label) label = candidate.name || candidate.role;
  if (label.length > 40) label = label.slice(0, 39) + "…";

  const confidence = Math.min(1, Math.max(0, Number(data.confidence) || 0));

  const irreversible =
    data.irreversible === true ||
    IRREVERSIBLE.test(label) ||
    (kind === "click" && IRREVERSIBLE.test(candidate.name));

  return { kind, target, value, label, confidence, irreversible };
}
