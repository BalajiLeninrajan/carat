// test/run.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// src/shared/redact.ts
var REDACTED = "\xABredacted\xBB";
var SENSITIVE_NAME = /(password|passcode|pin\b|cvv|cvc|security code|card number|ssn|social security|routing|account number|secret|token|api[ _-]?key|otp|one[- ]time)/i;
function isSensitiveName(name) {
  return SENSITIVE_NAME.test(name);
}
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
function scrubValue(text) {
  if (!text) return text;
  let out = text.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
    const digits = match.replace(/\D/g, "");
    return digits.length >= 13 && luhnValid(digits) ? REDACTED : match;
  });
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED);
  out = out.replace(/\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, REDACTED);
  return out;
}
function scrubNamedValue(name, value2) {
  if (!value2) return value2;
  if (isSensitiveName(name)) return REDACTED;
  return scrubValue(value2);
}
function hostIsBlocked(url, blocklist) {
  if (!blocklist.length) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return blocklist.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^\*\./, "");
    if (!entry) return false;
    return host === entry || host.endsWith("." + entry);
  });
}

// src/background/context.ts
var MAX_CHARS = 4800;
var MAX_TEXT = 240;
var MAX_HEADINGS = 12;
var CONTAINER_DEPTH = 5;
var PAGE_SWEEP_DEPTH = 6;
var CONTAINER_ROLES = /* @__PURE__ */ new Set([
  "form",
  "search",
  "region",
  "dialog",
  "alertdialog",
  "article",
  "main",
  "complementary",
  "table",
  "grid",
  "listitem",
  "group",
  "RootWebArea"
]);
var STRUCTURE_ROLES = /* @__PURE__ */ new Set([
  "form",
  "search",
  "region",
  "dialog",
  "alertdialog",
  "article",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "table",
  "grid",
  "list",
  "listitem",
  "tablist",
  "group",
  "figure",
  "blockquote"
]);
var CONTROL_ROLES = /* @__PURE__ */ new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "button",
  "link",
  "menuitem",
  "tab",
  "columnheader",
  "rowheader",
  "cell"
]);
var TEXT_ROLES = /* @__PURE__ */ new Set([
  "StaticText",
  "paragraph",
  "text",
  "caption",
  "Legend",
  "code",
  "emphasis",
  "strong"
]);
var TRANSPARENT_ROLES = /* @__PURE__ */ new Set(["LabelText", "ListMarker", "Abbr"]);
var SKIP_ROLES = /* @__PURE__ */ new Set([
  "InlineTextBox",
  "LineBreak",
  "none",
  "presentation",
  "generic",
  "GenericContainer",
  "Iframe",
  "IframePresentational",
  "ScrollArea",
  "Pre",
  "Ignored"
]);
function str(v) {
  const raw = v?.value;
  return typeof raw === "string" ? raw.trim() : "";
}
function prop(node2, name) {
  return node2.properties?.find((p) => p.name === name)?.value?.value;
}
function roleOf(node2) {
  return str(node2.role) || "generic";
}
function clip(text, max = MAX_TEXT) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "\u2026" : flat;
}
function index(nodes) {
  const byId = /* @__PURE__ */ new Map();
  const parentOf = /* @__PURE__ */ new Map();
  for (const node2 of nodes) byId.set(node2.nodeId, node2);
  for (const node2 of nodes) {
    for (const child of node2.childIds ?? []) parentOf.set(child, node2.nodeId);
  }
  const root = nodes.find((n) => !parentOf.has(n.nodeId)) ?? nodes[0];
  return { byId, root, parentOf };
}
function findFocused(nodes, field2) {
  const byFocusProp = nodes.find(
    (n) => prop(n, "focused") === true && CONTROL_ROLES.has(roleOf(n))
  );
  if (byFocusProp || !field2) return byFocusProp;
  const editable = nodes.filter((n) => {
    const role = roleOf(n);
    return role === "textbox" || role === "searchbox" || role === "combobox";
  });
  if (field2.name) {
    const byName = editable.find((n) => str(n.name) === field2.name.trim());
    if (byName) return byName;
  }
  if (field2.typed) {
    const byValue = editable.find((n) => str(n.value) === field2.typed);
    if (byValue) return byValue;
  }
  return editable.length === 1 ? editable[0] : void 0;
}
function ancestorsOf(node2, idx) {
  const chain = [];
  let current = idx.parentOf.get(node2.nodeId);
  let guard = 0;
  while (current && guard++ < 64) {
    const parent = idx.byId.get(current);
    if (!parent) break;
    chain.unshift(parent);
    current = idx.parentOf.get(parent.nodeId);
  }
  return chain;
}
function markSubtree(node2, idx, keep, priority, depth, seen = /* @__PURE__ */ new Set()) {
  if (depth < 0) return;
  if (seen.has(node2.nodeId)) return;
  seen.add(node2.nodeId);
  const existing = keep.get(node2.nodeId);
  if (existing === void 0 || priority < existing) keep.set(node2.nodeId, priority);
  const cost = SKIP_ROLES.has(roleOf(node2)) || TRANSPARENT_ROLES.has(roleOf(node2)) ? 0 : 1;
  for (const childId of node2.childIds ?? []) {
    const child = idx.byId.get(childId);
    if (child) markSubtree(child, idx, keep, priority, depth - cost, seen);
  }
}
function lineFor(node2, focusedId, parentName, includeFocusedValue) {
  const role = roleOf(node2);
  if (SKIP_ROLES.has(role)) return null;
  const name = clip(str(node2.name), 120);
  const isFocused = node2.nodeId === focusedId;
  if (isFocused) {
    const hint = str(node2.description);
    const bits = [`>> FOCUSED ${role}`];
    if (name) bits.push(`"${name}"`);
    const value2 = str(node2.value);
    if (includeFocusedValue && value2) bits.push(`= ${scrubNamedValue(name, clip(value2, 300))}`);
    if (hint) bits.push(`(hint: ${clip(hint, 80)})`);
    return bits.join(" ");
  }
  if (TEXT_ROLES.has(role)) {
    const text = clip(scrubValue(str(node2.name) || str(node2.value)));
    if (text.length <= 1) return null;
    if (parentName && parentName.includes(text)) return null;
    return `text: ${text}`;
  }
  if (role === "heading") {
    const level = prop(node2, "level");
    if (!name) return null;
    return `heading(${typeof level === "number" ? level : "?"}): ${name}`;
  }
  if (role === "image" || role === "img") {
    return name ? `image: ${name}` : null;
  }
  if (CONTROL_ROLES.has(role)) {
    const rawValue = str(node2.value);
    const value2 = rawValue ? scrubNamedValue(name, clip(rawValue, 120)) : "";
    const checked = prop(node2, "checked");
    const parts = [role];
    if (name) parts.push(`"${name}"`);
    if (value2) parts.push(`= ${value2}`);
    else if (typeof checked === "string") parts.push(`= ${checked}`);
    if (parts.length === 1) return null;
    return parts.join(" ");
  }
  if (STRUCTURE_ROLES.has(role)) {
    return name ? `${role} "${name}":` : `${role}:`;
  }
  return name ? `${role} "${name}"` : null;
}
var NUMBERED_ROLES = /* @__PURE__ */ new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "spinbutton",
  "slider",
  "treeitem"
]);
var MAX_CANDIDATES = 80;
var ACTION_MAX_CHARS = 6500;
function buildOutline(nodes, field2, url, title, opts = {}) {
  if (!nodes.length) return { text: "", focusedFound: false, candidates: [] };
  const idx = index(nodes);
  const focused = findFocused(nodes, field2);
  const keep = /* @__PURE__ */ new Map();
  const maxChars = opts.numberControls ? ACTION_MAX_CHARS : MAX_CHARS;
  const actionable = (node2) => NUMBERED_ROLES.has(roleOf(node2)) && !node2.ignored && prop(node2, "disabled") !== true && typeof node2.backendDOMNodeId === "number";
  if (opts.numberControls) {
    let marked = 0;
    for (const node2 of nodes) {
      if (!actionable(node2) || marked >= MAX_CANDIDATES) continue;
      marked++;
      keep.set(node2.nodeId, 1);
      for (const parent of ancestorsOf(node2, idx)) {
        if (!keep.has(parent.nodeId)) keep.set(parent.nodeId, 3);
      }
      if (roleOf(node2) === "combobox" || roleOf(node2) === "listbox") {
        markSubtree(node2, idx, keep, 2, 2);
      }
    }
  }
  if (focused) {
    keep.set(focused.nodeId, 0);
    const chain = ancestorsOf(focused, idx);
    for (const node2 of chain) keep.set(node2.nodeId, 0);
    const container = [...chain].reverse().find((n) => CONTAINER_ROLES.has(roleOf(n))) ?? chain[0];
    if (container) markSubtree(container, idx, keep, 1, CONTAINER_DEPTH);
  }
  if (idx.root) markSubtree(idx.root, idx, keep, 2, PAGE_SWEEP_DEPTH);
  let headings = 0;
  for (const node2 of nodes) {
    const role = roleOf(node2);
    const isLandmark = STRUCTURE_ROLES.has(role) && Boolean(str(node2.name));
    if (role === "heading" && headings < MAX_HEADINGS) {
      headings++;
    } else if (!isLandmark) {
      continue;
    }
    if (!keep.has(node2.nodeId)) keep.set(node2.nodeId, 2);
    for (const parent of ancestorsOf(node2, idx)) {
      if (!keep.has(parent.nodeId)) keep.set(parent.nodeId, 3);
    }
  }
  const lines = [];
  const candidates = [];
  const rendered = /* @__PURE__ */ new Set();
  const render = (node2, depth, parentName) => {
    if (rendered.has(node2.nodeId)) return;
    rendered.add(node2.nodeId);
    const role = roleOf(node2);
    const priority = keep.get(node2.nodeId);
    let nextDepth = depth;
    if (priority !== void 0 && node2.nodeId !== idx.root?.nodeId && !node2.ignored && !TRANSPARENT_ROLES.has(role)) {
      let line = lineFor(node2, focused?.nodeId, parentName, Boolean(opts.includeFocusedValue));
      if (line && opts.numberControls && actionable(node2) && candidates.length < MAX_CANDIDATES) {
        const n = candidates.length + 1;
        candidates.push({
          n,
          role,
          name: clip(str(node2.name), 120),
          backendNodeId: node2.backendDOMNodeId
        });
        line = line.startsWith(">> FOCUSED ") ? line.replace(">> FOCUSED ", `>> FOCUSED [${n}] `) : `[${n}] ${line}`;
      }
      if (line) {
        lines.push({ text: "  ".repeat(depth) + line, priority });
        nextDepth = depth + 1;
      }
    }
    if (TEXT_ROLES.has(role)) return;
    if (node2.nodeId === focused?.nodeId) return;
    const own = [str(node2.name), str(node2.value)].filter(Boolean).join(" ");
    for (const childId of node2.childIds ?? []) {
      const child = idx.byId.get(childId);
      const inherited = SKIP_ROLES.has(role) || TRANSPARENT_ROLES.has(role) ? parentName : own;
      if (child) render(child, nextDepth, inherited);
    }
  };
  if (idx.root) render(idx.root, 0, "");
  const header = `PAGE: ${clip(title, 120)} (${clip(url, 120)})`;
  let body = lines.map((l) => l.text).join("\n");
  for (let cut = 3; cut >= 1 && header.length + body.length > maxChars; cut--) {
    body = lines.filter((l) => l.priority < cut).map((l) => l.text).join("\n");
  }
  if (header.length + body.length > maxChars) {
    body = body.slice(0, maxChars - header.length) + "\n\u2026";
  }
  const text = `${header}
${body}`;
  const visible = candidates.filter((c) => text.includes(`[${c.n}] `));
  return { text, focusedFound: Boolean(focused), candidates: visible };
}

// src/shared/types.ts
var IRREVERSIBLE = /\b(send|submit|post|publish|pay|purchase|buy|order|checkout|check out|place|transfer|delete|remove|discard|archive|unsubscribe|cancel|confirm|sign|approve|merge|deploy)\b/i;

// src/background/prompt.ts
function sanitizeCompletion(raw, field2) {
  let text = raw;
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length > 1) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === '"' && last === '"' || first === "\u201C" && last === "\u201D") {
      text = trimmed.slice(1, -1);
    }
  }
  const typed = field2.typed;
  const maxOverlap = Math.min(typed.length, text.length, 60);
  for (let n = maxOverlap; n >= 4; n--) {
    if (typed.slice(-n).toLowerCase() === text.slice(0, n).toLowerCase()) {
      text = text.slice(n);
      break;
    }
  }
  if (!field2.multiline) {
    text = text.split(/[\r\n]/)[0];
  } else {
    text = text.replace(/\n{3,}/g, "\n\n");
  }
  if (/\s$/.test(typed)) text = text.replace(/^[ \t]+/, "");
  if (field2.maxLength && field2.maxLength > 0) {
    const room = field2.maxLength - typed.length - field2.trailing.length;
    if (room <= 0) return "";
    if (text.length > room) text = text.slice(0, room);
  }
  return text;
}
var FOCUSABLE_ROLES = /* @__PURE__ */ new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
var SELECTABLE_ROLES = /* @__PURE__ */ new Set(["combobox", "listbox"]);
function parseAction(raw, candidates) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let data;
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
  let kind = action;
  if (kind === "select" && !SELECTABLE_ROLES.has(candidate.role)) return null;
  if (kind === "click" && FOCUSABLE_ROLES.has(candidate.role) && candidate.role !== "combobox") {
    kind = "focus";
  }
  if (kind === "focus" && !FOCUSABLE_ROLES.has(candidate.role)) kind = "click";
  const value2 = typeof data.value === "string" ? scrubValue(data.value).slice(0, 300) : "";
  if (kind === "select" && !value2) return null;
  let label = typeof data.label === "string" ? data.label.replace(/\s+/g, " ").trim() : "";
  if (!label) label = candidate.name || candidate.role;
  if (label.length > 40) label = label.slice(0, 39) + "\u2026";
  const confidence = Math.min(1, Math.max(0, Number(data.confidence) || 0));
  const irreversible = data.irreversible === true || IRREVERSIBLE.test(label) || kind === "click" && IRREVERSIBLE.test(candidate.name);
  return { kind, target, value: value2, label, confidence, irreversible };
}

// test/run.ts
var failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(String(err instanceof Error ? err.stack : err).replace(/^/gm, "      "));
  }
}
var value = (v) => ({ type: "string", value: v });
var node = (nodeId, role, extra = {}) => {
  const { name, val, ...rest } = extra;
  return {
    nodeId,
    role: value(role),
    ...name ? { name: value(name) } : {},
    ...val ? { value: value(val) } : {},
    ...rest
  };
};
var tree = [
  node("1", "RootWebArea", { name: "Ticket #4821", childIds: ["2", "3", "10"] }),
  node("2", "heading", {
    name: "Printer offline after firmware update",
    properties: [{ name: "level", value: { type: "integer", value: 1 } }]
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
    properties: [{ name: "focused", value: { type: "booleanOrUndefined", value: true } }]
  }),
  node("14", "textbox", { name: "Card number", val: "4111 1111 1111 1111" })
];
var field = {
  role: "textbox",
  name: "Reply body",
  placeholder: "",
  multiline: true,
  maxLength: null,
  inputType: "textarea",
  typed: "Thanks for the details. Could you",
  trailing: ""
};
var outline = buildOutline(tree, field, "https://desk.example.com/t/4821", "Ticket #4821").text;
console.log("\n--- rendered outline ---\n" + outline + "\n------------------------\n");
test("finds the focused field", () => {
  assert.ok(outline.includes('>> FOCUSED textbox "Reply body"'));
});
test("does not leak the focused value into the outline", () => {
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
  const stale = tree.map((n) => n.nodeId === "13" ? { ...n, properties: [] } : n);
  const result = buildOutline(stale, field, "https://desk.example.com/t/4821", "Ticket");
  assert.ok(result.focusedFound);
  assert.ok(result.text.includes(">> FOCUSED"));
});
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
var realTree = JSON.parse(
  readFileSync("test/fixtures/axtree-form.json", "utf8")
);
var real = buildOutline(
  realTree,
  field,
  "http://127.0.0.1:8123/fixtures/form.html",
  "Ticket #4821 \u2014 Support Desk"
);
test("real tree: locates the focused field", () => {
  assert.ok(real.focusedFound);
  assert.ok(real.text.includes('>> FOCUSED textbox "Reply body"'));
});
test("real tree: reaches controls nested inside a <label>", () => {
  assert.ok(real.text.includes('combobox "Status" = Awaiting customer'));
  assert.ok(real.text.includes('textbox "Subject" = Re: Printer offline'));
});
test("real tree: reaches text under anonymous wrapper divs", () => {
  assert.ok(real.text.includes("It says 3.2.0.4711"));
  assert.ok(real.text.includes("HP M452 shows as offline"));
});
test("real tree: withholds the focused field's own text", () => {
  assert.ok(!real.text.includes(field.typed));
});
test("real tree: does not repeat a heading as both name and child text", () => {
  const occurrences = real.text.split("Printer offline after firmware update").length - 1;
  assert.equal(occurrences, 2);
});
test("real tree: stays inside the size budget", () => {
  assert.ok(real.text.length < 2e3, `${real.text.length} chars`);
});
test("real tree: terminates on repeated node ids", () => {
  const doubled = realTree.map(
    (n) => n.childIds?.length ? { ...n, childIds: [...n.childIds, n.childIds[0]] } : n
  );
  const out = buildOutline(doubled, field, "http://x", "t");
  assert.ok(out.text.length > 0);
});
var numbered = buildOutline(
  realTree,
  null,
  "http://127.0.0.1:8123/fixtures/form.html",
  "Ticket #4821 \u2014 Support Desk",
  { numberControls: true, includeFocusedValue: true }
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
var cands = [
  { n: 1, role: "combobox", name: "Status" },
  { n: 2, role: "textbox", name: "Subject" },
  { n: 3, role: "button", name: "Send reply" },
  { n: 4, role: "link", name: "All tickets" }
];
test("parse: accepts a well-formed click", () => {
  const a = parseAction(
    '{"action":"click","target":4,"value":"","label":"Back to tickets","confidence":0.8,"irreversible":false}',
    cands
  );
  assert.deepEqual(a, {
    kind: "click",
    target: 4,
    value: "",
    label: "Back to tickets",
    confidence: 0.8,
    irreversible: false
  });
});
test("parse: 'Send' is irreversible even when the model says it is not", () => {
  const a = parseAction(
    '{"action":"click","target":3,"value":"","label":"Send reply","confidence":0.9,"irreversible":false}',
    cands
  );
  assert.equal(a?.irreversible, true);
});
test("parse: a target that is not a candidate is refused", () => {
  assert.equal(
    parseAction('{"action":"click","target":99,"value":"","label":"x","confidence":1,"irreversible":false}', cands),
    null
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
    null
  );
  assert.equal(
    parseAction('{"action":"select","target":1,"value":"","label":"x","confidence":1,"irreversible":false}', cands),
    null
  );
  assert.equal(
    parseAction('{"action":"select","target":1,"value":"Resolved","label":"Status: Resolved","confidence":0.7,"irreversible":false}', cands)?.kind,
    "select"
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
console.log(failures ? `
${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
