import type { AXNode } from "./ax.js";
import type { FieldInfo } from "../shared/types.js";
import { scrubNamedValue, scrubValue } from "../shared/redact.js";

/**
 * Turns Chrome's raw accessibility tree into a compact, indented outline of the
 * page - the same semantic view a screen reader gets, minus everything the
 * model does not need. This is the whole point of Carat: an HTML dump of a
 * support console is 300KB; this is about 2KB and says more.
 */

const MAX_CHARS = 4800;
const MAX_TEXT = 240;
const MAX_HEADINGS = 12;
const CONTAINER_DEPTH = 5;
const PAGE_SWEEP_DEPTH = 6;

/** Roles that group content - we hunt upward for one of these around the field. */
const CONTAINER_ROLES = new Set([
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
  "RootWebArea",
]);

/** Roles rendered as a named group, and descended into. */
const STRUCTURE_ROLES = new Set([
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
  "blockquote",
]);

/** Roles rendered as a value-bearing control. */
const CONTROL_ROLES = new Set([
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
  "cell",
]);

/** Roles whose accessible name IS the content, so their children add nothing. */
const TEXT_ROLES = new Set([
  "StaticText",
  "paragraph",
  "text",
  "caption",
  "Legend",
  "code",
  "emphasis",
  "strong",
]);

/**
 * Wrappers that carry no line of their own but must still be descended into.
 * A <label> is the important one: its control is its child, so treating it as a
 * text leaf hides every input on the page.
 */
const TRANSPARENT_ROLES = new Set(["LabelText", "ListMarker", "Abbr"]);

const SKIP_ROLES = new Set([
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
  "Ignored",
]);

type Priority = 0 | 1 | 2 | 3;

function str(v: { value?: unknown } | undefined): string {
  const raw = v?.value;
  return typeof raw === "string" ? raw.trim() : "";
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

function roleOf(node: AXNode): string {
  return str(node.role) || "generic";
}

function clip(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

interface Indexed {
  byId: Map<string, AXNode>;
  root: AXNode | undefined;
  parentOf: Map<string, string>;
}

function index(nodes: AXNode[]): Indexed {
  const byId = new Map<string, AXNode>();
  const parentOf = new Map<string, string>();
  for (const node of nodes) byId.set(node.nodeId, node);
  for (const node of nodes) {
    for (const child of node.childIds ?? []) parentOf.set(child, node.nodeId);
  }
  const root = nodes.find((n) => !parentOf.has(n.nodeId)) ?? nodes[0];
  return { byId, root, parentOf };
}

/**
 * Locate the field the user is typing in. The `focused` AX property is the
 * reliable signal; the name/value match is the fallback for a cached tree that
 * predates the focus change.
 */
function findFocused(nodes: AXNode[], field: FieldInfo | null): AXNode | undefined {
  const byFocusProp = nodes.find(
    (n) => prop(n, "focused") === true && CONTROL_ROLES.has(roleOf(n)),
  );
  if (byFocusProp || !field) return byFocusProp;

  const editable = nodes.filter((n) => {
    const role = roleOf(n);
    return role === "textbox" || role === "searchbox" || role === "combobox";
  });
  if (field.name) {
    const byName = editable.find((n) => str(n.name) === field.name.trim());
    if (byName) return byName;
  }
  if (field.typed) {
    const byValue = editable.find((n) => str(n.value) === field.typed);
    if (byValue) return byValue;
  }
  return editable.length === 1 ? editable[0] : undefined;
}

function ancestorsOf(node: AXNode, idx: Indexed): AXNode[] {
  const chain: AXNode[] = [];
  let current = idx.parentOf.get(node.nodeId);
  let guard = 0;
  while (current && guard++ < 64) {
    const parent = idx.byId.get(current);
    if (!parent) break;
    chain.unshift(parent);
    current = idx.parentOf.get(parent.nodeId);
  }
  return chain;
}

function markSubtree(
  node: AXNode,
  idx: Indexed,
  keep: Map<string, Priority>,
  priority: Priority,
  depth: number,
  seen: Set<string> = new Set(),
): void {
  if (depth < 0) return;
  // Wrappers cost no depth, so a node reachable by two paths would otherwise
  // recurse without end.
  if (seen.has(node.nodeId)) return;
  seen.add(node.nodeId);
  const existing = keep.get(node.nodeId);
  if (existing === undefined || priority < existing) keep.set(node.nodeId, priority);
  // Anonymous wrappers (div soup) do not count against the budget - otherwise a
  // few nested layout divs hide the page's actual text.
  const cost = SKIP_ROLES.has(roleOf(node)) || TRANSPARENT_ROLES.has(roleOf(node)) ? 0 : 1;
  for (const childId of node.childIds ?? []) {
    const child = idx.byId.get(childId);
    if (child) markSubtree(child, idx, keep, priority, depth - cost, seen);
  }
}

/** One rendered line, or null when the node carries nothing worth a line. */
function lineFor(
  node: AXNode,
  focusedId: string | undefined,
  parentName: string,
  includeFocusedValue: boolean,
): string | null {
  const role = roleOf(node);
  if (SKIP_ROLES.has(role)) return null;

  const name = clip(str(node.name), 120);
  const isFocused = node.nodeId === focusedId;

  if (isFocused) {
    const hint = str(node.description);
    const bits = [`>> FOCUSED ${role}`];
    if (name) bits.push(`"${name}"`);
    // For text completion the value is sent separately as the prefix; for
    // action prediction it is context like any other field's.
    const value = str(node.value);
    if (includeFocusedValue && value) bits.push(`= ${scrubNamedValue(name, clip(value, 300))}`);
    if (hint) bits.push(`(hint: ${clip(hint, 80)})`);
    return bits.join(" ");
  }

  if (TEXT_ROLES.has(role)) {
    const text = clip(scrubValue(str(node.name) || str(node.value)));
    if (text.length <= 1) return null;
    // A heading or button already printed this text as its own name.
    if (parentName && parentName.includes(text)) return null;
    return `text: ${text}`;
  }

  if (role === "heading") {
    const level = prop(node, "level");
    if (!name) return null;
    return `heading(${typeof level === "number" ? level : "?"}): ${name}`;
  }

  if (role === "image" || role === "img") {
    return name ? `image: ${name}` : null;
  }

  if (CONTROL_ROLES.has(role)) {
    const rawValue = str(node.value);
    const value = rawValue ? scrubNamedValue(name, clip(rawValue, 120)) : "";
    const checked = prop(node, "checked");
    const parts = [role];
    if (name) parts.push(`"${name}"`);
    if (value) parts.push(`= ${value}`);
    else if (typeof checked === "string") parts.push(`= ${checked}`);
    if (parts.length === 1) return null;
    return parts.join(" ");
  }

  if (STRUCTURE_ROLES.has(role)) {
    return name ? `${role} "${name}":` : `${role}:`;
  }

  return name ? `${role} "${name}"` : null;
}

/** Roles the user can act on, which get an [n] in action-prediction mode. */
const NUMBERED_ROLES = new Set([
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
  "treeitem",
]);

const MAX_CANDIDATES = 80;
const ACTION_MAX_CHARS = 6500;

export interface Candidate {
  n: number;
  role: string;
  name: string;
  /** CDP handle for mapping the model's pick back onto a DOM element. */
  backendNodeId: number;
}

export interface OutlineOptions {
  /** Prefix every actionable control with [n] and collect them as candidates. */
  numberControls?: boolean;
  /** Show the focused field's own text in the outline. */
  includeFocusedValue?: boolean;
}

export interface OutlineResult {
  text: string;
  /** False when we could not locate the field - a hint that the tree is stale. */
  focusedFound: boolean;
  /** Numbered controls, in the order they appear. Empty unless numberControls. */
  candidates: Candidate[];
}

export function buildOutline(
  nodes: AXNode[],
  field: FieldInfo | null,
  url: string,
  title: string,
  opts: OutlineOptions = {},
): OutlineResult {
  if (!nodes.length) return { text: "", focusedFound: false, candidates: [] };

  const idx = index(nodes);
  const focused = findFocused(nodes, field);
  const keep = new Map<string, Priority>();
  const maxChars = opts.numberControls ? ACTION_MAX_CHARS : MAX_CHARS;

  const actionable = (node: AXNode): boolean =>
    NUMBERED_ROLES.has(roleOf(node)) &&
    !node.ignored &&
    prop(node, "disabled") !== true &&
    typeof node.backendDOMNodeId === "number";

  if (opts.numberControls) {
    // Every control is a possible next move, so every control has to survive
    // the budget - more so than the prose around it.
    let marked = 0;
    for (const node of nodes) {
      if (!actionable(node) || marked >= MAX_CANDIDATES) continue;
      marked++;
      keep.set(node.nodeId, 1);
      for (const parent of ancestorsOf(node, idx)) {
        if (!keep.has(parent.nodeId)) keep.set(parent.nodeId, 3);
      }
      // A dropdown's options are what a "select" prediction picks between.
      if (roleOf(node) === "combobox" || roleOf(node) === "listbox") {
        markSubtree(node, idx, keep, 2, 2);
      }
    }
  }

  if (focused) {
    keep.set(focused.nodeId, 0);
    const chain = ancestorsOf(focused, idx);
    for (const node of chain) keep.set(node.nodeId, 0);

    // Siblings inside the nearest container are the first-class context: the
    // other fields of the same form.
    const container = [...chain].reverse().find((n) => CONTAINER_ROLES.has(roleOf(n))) ?? chain[0];
    if (container) markSubtree(container, idx, keep, 1, CONTAINER_DEPTH);
  }

  // A shallow sweep of the whole page picks up the prose that gives a reply box
  // something to reply to. It is priority 2, so it is the first thing dropped
  // when the outline runs over budget.
  if (idx.root) markSubtree(idx.root, idx, keep, 2, PAGE_SWEEP_DEPTH);

  // The heading spine tells the model what page this is at all.
  let headings = 0;
  for (const node of nodes) {
    const role = roleOf(node);
    const isLandmark = STRUCTURE_ROLES.has(role) && Boolean(str(node.name));
    if (role === "heading" && headings < MAX_HEADINGS) {
      headings++;
    } else if (!isLandmark) {
      continue;
    }
    if (!keep.has(node.nodeId)) keep.set(node.nodeId, 2);
    for (const parent of ancestorsOf(node, idx)) {
      if (!keep.has(parent.nodeId)) keep.set(parent.nodeId, 3);
    }
  }

  const lines: { text: string; priority: Priority }[] = [];
  const candidates: Candidate[] = [];
  const rendered = new Set<string>();
  const render = (node: AXNode, depth: number, parentName: string): void => {
    if (rendered.has(node.nodeId)) return;
    rendered.add(node.nodeId);
    const role = roleOf(node);
    const priority = keep.get(node.nodeId);
    let nextDepth = depth;

    if (
      priority !== undefined &&
      node.nodeId !== idx.root?.nodeId &&
      !node.ignored &&
      !TRANSPARENT_ROLES.has(role)
    ) {
      let line = lineFor(node, focused?.nodeId, parentName, Boolean(opts.includeFocusedValue));
      if (line && opts.numberControls && actionable(node) && candidates.length < MAX_CANDIDATES) {
        const n = candidates.length + 1;
        candidates.push({
          n,
          role,
          name: clip(str(node.name), 120),
          backendNodeId: node.backendDOMNodeId as number,
        });
        line = line.startsWith(">> FOCUSED ")
          ? line.replace(">> FOCUSED ", `>> FOCUSED [${n}] `)
          : `[${n}] ${line}`;
      }
      if (line) {
        lines.push({ text: "  ".repeat(depth) + line, priority });
        nextDepth = depth + 1;
      }
    }

    // Text roles own their subtree - descending would repeat every word.
    if (TEXT_ROLES.has(role)) return;
    // The focused field's text is already on its own line (or, for text
    // completion, sent separately as the prefix); its text nodes would repeat it.
    if (node.nodeId === focused?.nodeId) return;

    // Only the immediate parent's own text suppresses a duplicate child - an
    // inherited name (the document title, say) would silence the whole page.
    const own = [str(node.name), str(node.value)].filter(Boolean).join(" ");
    for (const childId of node.childIds ?? []) {
      const child = idx.byId.get(childId);
      // Wrappers pass their parent's text through, so a value split across an
      // anonymous node still suppresses its duplicate.
      const inherited = SKIP_ROLES.has(role) || TRANSPARENT_ROLES.has(role) ? parentName : own;
      if (child) render(child, nextDepth, inherited);
    }
  };
  if (idx.root) render(idx.root, 0, "");

  const header = `PAGE: ${clip(title, 120)} (${clip(url, 120)})`;
  let body = lines.map((l) => l.text).join("\n");

  // Over budget: shed the least relevant lines first, never the field's own
  // neighbourhood.
  for (let cut = 3; cut >= 1 && header.length + body.length > maxChars; cut--) {
    body = lines
      .filter((l) => l.priority < cut)
      .map((l) => l.text)
      .join("\n");
  }
  if (header.length + body.length > maxChars) {
    body = body.slice(0, maxChars - header.length) + "\n…";
  }

  const text = `${header}\n${body}`;
  // A candidate whose line was shed is not something the model could have
  // picked; keep only the ones that made it into the text.
  const visible = candidates.filter((c) => text.includes(`[${c.n}] `));
  return { text, focusedFound: Boolean(focused), candidates: visible };
}
