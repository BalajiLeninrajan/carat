import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOutline } from "../src/background/context.js";
import type { AXNode } from "../src/background/ax.js";
import { sanitizeCompletion, parseAction } from "../src/background/prompt.js";
import { scrubValue, hostIsBlocked } from "../src/shared/redact.js";
import type { FieldInfo } from "../src/shared/types.js";

let failures = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(String(err instanceof Error ? err.stack : err).replace(/^/gm, "      "));
  }
}

// --- a synthetic accessibility tree, shaped like Chrome's ------------------

const value = (v: string) => ({ type: "string", value: v });
const node = (
  nodeId: string,
  role: string,
  extra: Partial<AXNode> & { name?: string; val?: string } = {},
): AXNode => {
  const { name, val, ...rest } = extra as any;
  return {
    nodeId,
    role: value(role),
    ...(name ? { name: value(name) } : {}),
    ...(val ? { value: value(val) } : {}),
    ...rest,
  };
};

const tree: AXNode[] = [
  node("1", "RootWebArea", { name: "Ticket #4821", childIds: ["2", "3", "10"] }),
  node("2", "heading", {
    name: "Printer offline after firmware update",
    properties: [{ name: "level", value: { type: "integer", value: 1 } }],
  }),
  node("3", "region", { name: "Conversation", childIds: ["4", "5"] }),
  node("4", "StaticText", { name: "Customer: Since the 3.2 update my M452 shows offline." }),
  node("5", "StaticText", { name: "Agent: Can you confirm the firmware version?" }),
  node("10", "form", { name: "Reply", childIds: ["11", "12", "13", "14"] }),
  node("11", "combobox", { name: "Status", val: "Pending" }),
  node("12", "textbox", { name: "Subject", val: "Re: Printer offline" }),
  node("13", "textbox", {
    name: "Reply body",
    val: "Thanks for the details. Could you",
    properties: [{ name: "focused", value: { type: "booleanOrUndefined", value: true } }],
  }),
  node("14", "textbox", { name: "Card number", val: "4111 1111 1111 1111" }),
];

const field: FieldInfo = {
  role: "textbox",
  name: "Reply body",
  placeholder: "",
  multiline: true,
  maxLength: null,
  inputType: "textarea",
  typed: "Thanks for the details. Could you",
  trailing: "",
};

const outline = buildOutline(tree, field, "https://desk.example.com/t/4821", "Ticket #4821").text;

console.log("\n--- rendered outline ---\n" + outline + "\n------------------------\n");

test("finds the focused field", () => {
  assert.ok(outline.includes('>> FOCUSED textbox "Reply body"'));
});

test("does not leak the focused value into the outline", () => {
  // It is sent separately as the completion prefix; repeating it invites echoes.
  assert.ok(!outline.includes("Thanks for the details"));
});

test("keeps sibling form fields with their values", () => {
  assert.ok(outline.includes('combobox "Status" = Pending'));
  assert.ok(outline.includes('textbox "Subject" = Re: Printer offline'));
});

test("keeps the conversation above the reply box", () => {
  assert.ok(outline.includes("Since the 3.2 update my M452 shows offline"));
});

test("keeps the heading spine", () => {
  assert.ok(outline.includes("heading(1): Printer offline after firmware update"));
});

test("redacts a card number found in a sibling field", () => {
  assert.ok(!outline.includes("4111 1111 1111 1111"));
  assert.ok(outline.includes("redacted"));
});

test("indents structure under its parent", () => {
  const line = outline.split("\n").find((l) => l.includes('combobox "Status"'));
  assert.ok(line && line.startsWith("  "), `expected indentation, got ${JSON.stringify(line)}`);
});

test("falls back to name matching when no node is marked focused", () => {
  const stale = tree.map((n) => (n.nodeId === "13" ? { ...n, properties: [] } : n));
  const result = buildOutline(stale, field, "https://desk.example.com/t/4821", "Ticket");
  assert.ok(result.focusedFound);
  assert.ok(result.text.includes(">> FOCUSED"));
});

// --- completion sanitising -------------------------------------------------

test("strips an echoed prefix", () => {
  const out = sanitizeCompletion("Could you confirm the firmware version?", field);
  assert.equal(out, " confirm the firmware version?");
});

test("collapses a doubled space after a trailing space", () => {
  const spaced = { ...field, typed: "Thanks for " };
  assert.equal(sanitizeCompletion("  the details", spaced), "the details");
});

test("keeps single-line completions to one line", () => {
  const single = { ...field, multiline: false, typed: "wireless mech" };
  assert.equal(sanitizeCompletion("anical keyboard\nwith switches", single), "anical keyboard");
});

test("unwraps quoted output", () => {
  const single = { ...field, multiline: false, typed: "abc" };
  assert.equal(sanitizeCompletion('"defg"', single), "defg");
});

test("respects maxlength", () => {
  const capped = { ...field, maxLength: 40, typed: "0123456789012345678901234567890123456" };
  assert.equal(sanitizeCompletion("abcdefgh", capped).length, 3);
});

// --- redaction -------------------------------------------------------------

test("scrubs Luhn-valid card numbers but not arbitrary digits", () => {
  assert.ok(scrubValue("pay with 4111 1111 1111 1111 today").includes("redacted"));
  assert.equal(scrubValue("order 1234567890123456789 shipped").includes("redacted"), false);
});

test("scrubs SSNs and api keys", () => {
  assert.ok(scrubValue("ssn 123-45-6789").includes("redacted"));
  assert.ok(scrubValue("sk-abcdefghijklmnopqrstuvwx").includes("redacted"));
});

test("blocklist matches subdomains only", () => {
  assert.equal(hostIsBlocked("https://mail.chase.com/x", ["chase.com"]), true);
  assert.equal(hostIsBlocked("https://notchase.com/x", ["chase.com"]), false);
});

// --- against a real tree captured from Chrome -----------------------------
// test/fixtures/axtree-form.json is Accessibility.getFullAXTree output for
// test/fixtures/form.html. Every assertion below is a bug this fixture caught.

const realTree: AXNode[] = JSON.parse(
  readFileSync("test/fixtures/axtree-form.json", "utf8"),
);
const real = buildOutline(
  realTree,
  field,
  "http://127.0.0.1:8123/fixtures/form.html",
  "Ticket #4821 — Support Desk",
);

test("real tree: locates the focused field", () => {
  assert.ok(real.focusedFound);
  assert.ok(real.text.includes('>> FOCUSED textbox "Reply body"'));
});

test("real tree: reaches controls nested inside a <label>", () => {
  // <label> has role LabelText; treating it as a text leaf hid every input.
  assert.ok(real.text.includes('combobox "Status" = Awaiting customer'));
  assert.ok(real.text.includes('textbox "Subject" = Re: Printer offline'));
});

test("real tree: reaches text under anonymous wrapper divs", () => {
  // Layout divs appear as role "none"; counting them against the depth budget
  // hid the conversation the reply is actually about.
  assert.ok(real.text.includes("It says 3.2.0.4711"));
  assert.ok(real.text.includes("HP M452 shows as offline"));
});

test("real tree: withholds the focused field's own text", () => {
  assert.ok(!real.text.includes(field.typed));
});

test("real tree: does not repeat a heading as both name and child text", () => {
  const occurrences = real.text.split("Printer offline after firmware update").length - 1;
  assert.equal(occurrences, 2); // the page title line, and the h1 - not the h1 twice
});

test("real tree: stays inside the size budget", () => {
  assert.ok(real.text.length < 2000, `${real.text.length} chars`);
});

test("real tree: terminates on repeated node ids", () => {
  // Chrome reuses node ids across paths; without a cycle guard the mark phase
  // never returned and the request silently never fired.
  const doubled = realTree.map((n) =>
    n.childIds?.length ? { ...n, childIds: [...n.childIds, n.childIds[0]] } : n,
  );
  const out = buildOutline(doubled, field, "http://x", "t");
  assert.ok(out.text.length > 0);
});

// --- next-action prediction -------------------------------------------------

const numbered = buildOutline(
  realTree,
  null,
  "http://127.0.0.1:8123/fixtures/form.html",
  "Ticket #4821 — Support Desk",
  { numberControls: true, includeFocusedValue: true },
);

console.log("\n--- numbered outline (action mode) ---\n" + numbered.text + "\n--------------------------------------\n");

test("actions: numbers the controls a user can act on", () => {
  const send = numbered.candidates.find((c) => c.name === "Send reply");
  assert.ok(send, "Send reply is a candidate");
  assert.equal(send.role, "button");
  assert.equal(typeof send.backendNodeId, "number");
  assert.ok(numbered.text.includes(`[${send.n}] button "Send reply"`));
});

test("actions: marks the focused field with its number and its text", () => {
  // Unlike text completion, the field's contents are context here: what they
  // wrote decides whether they send, resolve, or keep going.
  assert.match(numbered.text, />> FOCUSED \[\d+\] textbox "Reply body" = Thanks for the details/);
});

test("actions: lists dropdown options without numbering them", () => {
  assert.ok(numbered.text.includes('option "Resolved"'));
  assert.ok(!/\[\d+\] option/.test(numbered.text), "options are chosen via their combobox");
});

test("actions: every candidate is visible in the text the model sees", () => {
  for (const c of numbered.candidates) assert.ok(numbered.text.includes(`[${c.n}] `), `[${c.n}]`);
});

test("actions: text mode is unchanged - no numbers, no focused value", () => {
  assert.ok(!/\[\d+\] /.test(real.text));
  assert.equal(real.candidates.length, 0);
});

const cands = [
  { n: 1, role: "combobox", name: "Status" },
  { n: 2, role: "textbox", name: "Subject" },
  { n: 3, role: "button", name: "Send reply" },
  { n: 4, role: "link", name: "All tickets" },
];

test("parse: accepts a well-formed click", () => {
  const a = parseAction(
    '{"action":"click","target":4,"value":"","label":"Back to tickets","confidence":0.8,"irreversible":false}',
    cands,
  );
  assert.deepEqual(a, {
    kind: "click",
    target: 4,
    value: "",
    label: "Back to tickets",
    confidence: 0.8,
    irreversible: false,
  });
});

test("parse: 'Send' is irreversible even when the model says it is not", () => {
  const a = parseAction(
    '{"action":"click","target":3,"value":"","label":"Send reply","confidence":0.9,"irreversible":false}',
    cands,
  );
  assert.equal(a?.irreversible, true);
});

test("parse: a target that is not a candidate is refused", () => {
  assert.equal(
    parseAction('{"action":"click","target":99,"value":"","label":"x","confidence":1,"irreversible":false}', cands),
    null,
  );
});

test("parse: 'none', prose and broken JSON all mean no suggestion", () => {
  assert.equal(parseAction('{"action":"none","target":0,"value":"","label":"","confidence":0.1,"irreversible":false}', cands), null);
  assert.equal(parseAction("I think they will click send.", cands), null);
  assert.equal(parseAction('{"action":"click","target":', cands), null);
});

test("parse: finds the JSON inside a chatty reply", () => {
  const a = parseAction('Sure! {"action":"click","target":4,"value":"","label":"All tickets","confidence":0.7,"irreversible":false} Hope that helps.', cands);
  assert.equal(a?.target, 4);
});

test("parse: select must target a dropdown and name an option", () => {
  assert.equal(
    parseAction('{"action":"select","target":3,"value":"Resolved","label":"x","confidence":1,"irreversible":false}', cands),
    null,
  );
  assert.equal(
    parseAction('{"action":"select","target":1,"value":"","label":"x","confidence":1,"irreversible":false}', cands),
    null,
  );
  assert.equal(
    parseAction('{"action":"select","target":1,"value":"Resolved","label":"Status: Resolved","confidence":0.7,"irreversible":false}', cands)?.kind,
    "select",
  );
});

test("parse: 'click' on a text field becomes 'focus'", () => {
  const a = parseAction('{"action":"click","target":2,"value":"Re: hi","label":"Subject","confidence":0.6,"irreversible":false}', cands);
  assert.equal(a?.kind, "focus");
});

test("parse: confidence is clamped to 0..1", () => {
  const a = parseAction('{"action":"click","target":4,"value":"","label":"x","confidence":7,"irreversible":false}', cands);
  assert.equal(a?.confidence, 1);
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
