/**
 * Accessibility tree → compact, indented page outline for the model.
 *
 *   PAGE: Ticket #4821 — Support Desk (https://desk.example.com/t/4821)
 *   main:
 *     heading(1) "Printer offline after firmware update"
 *     region "Conversation":
 *       text: Since the update my M452 shows offline…
 *     form "Reply":
 *       [4] combobox "Status" = "Pending"
 *       >> FOCUSED [5] textbox "Reply body"
 *       [6] button "Send reply"
 *
 * Two modes:
 * - "text": for ghost text. Controls are not numbered, and the focused field's
 *   value is left out (it is sent separately as the prefix, and leaving it out
 *   keeps the outline identical across keystrokes, which keeps the prompt cache warm).
 * - "action": for next-action prediction. Every operable control gets an [n],
 *   and `candidates` maps n back to the DOM node.
 *
 * Landmarks and named groups add indentation. Generic wrappers are transparent.
 * When the outline is over budget, lines farthest from the focus are dropped first:
 * page text, then list options, then controls and headings.
 */

import { registrableDomain } from "@carat/shared";
import { maskSensitive } from "./redact";
import { prop, type AXNode } from "./ax";

export type OutlineMode = "text" | "action";

export interface Candidate {
  n: number;
  backendNodeId: number;
  role: string;
  name: string;
  /** Carat's addition: the same states the line shows, space separated, for the chip's preview line. */
  state?: string;
  /** Carat's addition: the registrable domain a link leads to. */
  host?: string;
  /** Carat's addition: the CDP frame the node lives in, when it is not the top one. */
  frameId?: string;
}

export interface Outline {
  text: string;
  candidates: Candidate[];
  /** Accessible role and name of the focused node, if it is in the tree. */
  focused: { role: string; name: string } | null;
  stats: { nodes: number; lines: number; dropped: number; chars: number };
}

export interface OutlineOptions {
  mode: OutlineMode;
  url: string;
  focusedBackendId: number | null;
  /** Live value of the focused field (the AX copy can be stale). Action mode only. */
  focusedValue?: string;
  /** Character budget for the whole outline. */
  budget?: number;
  /** Maximum numbered controls in action mode. */
  maxCandidates?: number;
  /** Carat's addition: backendNodeId -> href, for the host written after a link. */
  hrefs?: ReadonlyMap<number, string>;
  /** Carat's addition: backendNodeId -> the CDP frame it lives in, for performing across a frame boundary. */
  frameIds?: ReadonlyMap<number, string>;
}

/** Landmarks and containers that get their own line and indent their contents. */
const LANDMARKS = new Set([
  "banner", "navigation", "main", "contentinfo", "complementary", "search", "form",
  "dialog", "alertdialog",
]);
/** Containers shown only when they have an accessible name. */
const NAMED_CONTAINERS = new Set([
  "region", "group", "radiogroup", "article", "tablist", "tabpanel", "menu", "menubar",
  "toolbar", "listbox", "tree", "table", "grid", "list", "figure",
]);
/** Controls a user can operate. These are numbered in action mode. */
const CONTROLS = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "treeitem", "textbox", "searchbox", "combobox", "slider",
  "spinbutton",
]);
/** Controls that are useless to the model without a name. */
const NEEDS_NAME = new Set(["button", "link", "tab", "menuitem", "option", "treeitem"]);
/** Roles whose children never add anything (the name already covers them). */
const LEAF_TEXT = new Set(["StaticText", "InlineTextBox", "LineBreak"]);
/** Inline roles: text inside them continues the surrounding sentence. */
const INLINE = new Set([
  "StaticText", "InlineTextBox", "LineBreak", "strong", "emphasis", "code", "mark", "time",
  "abbr", "subscript", "superscript", "insertion", "deletion", "generic",
]);
/** Status/alert text is always worth keeping. */
const LIVE = new Set(["alert", "status", "log", "marquee", "timer"]);

const MAX_NAME = 90;
const MAX_VALUE = 120;
const MAX_TEXT_LINE = 240;
const MAX_OPTIONS = 12;

type LineKind = "struct" | "heading" | "control" | "option" | "text";

interface Line {
  indent: number;
  kind: LineKind;
  text: string;
  /** Position in document order, used for distance-from-focus ranking. */
  order: number;
  focused?: boolean;
  keep?: boolean;
  candidate?: { backendNodeId: number; role: string; name: string };
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

function quote(s: string, max: number): string {
  return JSON.stringify(clip(maskSensitive(s), max));
}

function roleOf(node: AXNode): string {
  const r = str(node.role?.value);
  return r === "MenuListOption" ? "option" : r;
}

/** States worth telling the model about, as a " (checked, required)" suffix. */
function states(node: AXNode, role: string): string {
  const out: string[] = [];
  const checked = prop(node, "checked");
  if (checked === "true" || checked === true) out.push("checked");
  else if (checked === "mixed") out.push("mixed");
  else if (checked === "false" || checked === false) out.push("unchecked");
  const pressed = prop(node, "pressed");
  if (pressed === "true" || pressed === true) out.push("pressed");
  const expanded = prop(node, "expanded");
  if (expanded === true) out.push("expanded");
  else if (expanded === false) out.push("collapsed");
  if (prop(node, "selected") === true && role !== "option") out.push("selected");
  if (prop(node, "disabled") === true) out.push("disabled");
  if (prop(node, "required") === true) out.push("required");
  const invalid = prop(node, "invalid");
  if (invalid && invalid !== "false") out.push("invalid");
  if (prop(node, "readonly") === true) out.push("readonly");
  // Carat's addition: a button that opens a dialog or a menu is a step of its
  // own, not somewhere to type, and the model has to be told which.
  const popup = prop(node, "haspopup");
  if (typeof popup === "string" && popup !== "false") out.push(`opens ${popup}`);
  if (role === "link" && prop(node, "visited") === true) out.push("visited");
  return out.length ? ` (${out.join(", ")})` : "";
}

/** The same states, space separated rather than parenthesised: what OutlineControl.state holds. */
function stateWords(node: AXNode, role: string): string {
  return states(node, role).replace(/^ \(|\)$/g, "").split(", ").filter(Boolean).join(" ");
}

/** The registrable domain a link leads to, from the href the page snapshot carried. */
function linkHost(opts: OutlineOptions, backendNodeId: number | undefined): string | undefined {
  const href = backendNodeId == null ? undefined : opts.hrefs?.get(backendNodeId);
  if (!href || href.startsWith("#")) return undefined;
  try {
    const url = new URL(href, opts.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return registrableDomain(url.hostname) || undefined;
  } catch {
    return undefined;
  }
}

export function buildOutline(nodes: AXNode[], opts: OutlineOptions): Outline {
  const budget = opts.budget ?? (opts.mode === "action" ? 9000 : 6000);
  const maxCandidates = opts.maxCandidates ?? 60;

  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const lines: Line[] = [];
  let order = 0;
  let focusedInfo: Outline["focused"] = null;

  // Consecutive text is merged into one line until something non-inline interrupts it.
  let textBuf: string[] = [];
  let textIndent = 0;
  const flush = () => {
    const joined = textBuf.join(" ").replace(/\s+/g, " ").trim();
    textBuf = [];
    if (joined) lines.push({ indent: textIndent, kind: "text", text: "text: " + clip(maskSensitive(joined), MAX_TEXT_LINE), order: order++ });
  };
  const push = (line: Omit<Line, "order">) => {
    flush();
    lines.push({ ...line, order: order++ });
  };

  const visited = new Set<string>();

  /**
   * @param indent current indentation level
   * @param inNamed true inside a node whose name already covers its text
   * @param optionBudget remaining options to list under a combobox/listbox
   */
  function walk(node: AXNode | undefined, indent: number, inNamed: boolean, optionBudget: { left: number } | null): void {
    // Chrome can reuse ids across subtrees; never visit a node twice.
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);

    const children = () => node.childIds?.map((id) => byId.get(id)) ?? [];
    const walkChildren = (i: number, named: boolean, ob = optionBudget) => {
      for (const c of children()) walk(c, i, named, ob);
    };

    if (node.ignored) {
      walkChildren(indent, inNamed);
      return;
    }

    const role = roleOf(node);
    const name = str(node.name?.value);
    const isFocused = opts.focusedBackendId != null && node.backendDOMNodeId === opts.focusedBackendId;

    if (LEAF_TEXT.has(role)) {
      if (!inNamed && role === "StaticText" && name.trim()) {
        if (!textBuf.length) textIndent = indent;
        textBuf.push(name);
      }
      return;
    }

    if (role === "heading") {
      const level = prop(node, "level");
      push({ indent, kind: "heading", text: `heading(${str(level) || "?"}) ${quote(name, MAX_NAME)}` });
      walkChildren(indent + 1, true);
      return;
    }

    if (CONTROLS.has(role)) {
      if (NEEDS_NAME.has(role) && !name.trim() && !isFocused) {
        walkChildren(indent, inNamed);
        return;
      }
      const disabled = prop(node, "disabled") === true;
      let value = str(node.value?.value);
      if (isFocused) {
        focusedInfo = { role, name };
        value = opts.mode === "text" ? "" : opts.focusedValue ?? value;
      }
      // Links carry their URL as the value; it is noise for the model.
      if (role === "link") value = "";
      const valuePart = value && value !== name ? ` = ${quote(value, MAX_VALUE)}` : "";
      const namePart = name.trim() ? " " + quote(name, MAX_NAME) : "";
      const text = `${role}${namePart}${valuePart}${states(node, role)}`;

      // Options inside a combobox/listbox: listed under it, capped, never numbered.
      if (role === "option" && optionBudget) {
        if (optionBudget.left-- > 0) push({ indent, kind: "option", text });
        return;
      }

      const numbered = opts.mode === "action" && !disabled && node.backendDOMNodeId != null;
      const host = role === "link" ? linkHost(opts, node.backendDOMNodeId) : undefined;
      const frameId = node.backendDOMNodeId == null ? undefined : opts.frameIds?.get(node.backendDOMNodeId);
      push({
        indent,
        kind: "control",
        text: host ? `${role}${namePart} -> ${host}${states(node, role)}` : text,
        focused: isFocused,
        candidate: numbered
          ? {
              backendNodeId: node.backendDOMNodeId!,
              role,
              name: clip(name, MAX_NAME),
              ...(stateWords(node, role) ? { state: stateWords(node, role) } : {}),
              ...(host ? { host } : {}),
              ...(frameId ? { frameId } : {}),
            }
          : undefined,
      });
      const listsOptions = role === "combobox" || role === "listbox";
      walkChildren(indent + 1, true, listsOptions ? { left: MAX_OPTIONS } : null);
      return;
    }

    if (role === "listbox" && !optionBudget) {
      // A standalone listbox: its options are real click targets.
      if (name) push({ indent, kind: "struct", text: `listbox ${quote(name, MAX_NAME)}:` });
      walkChildren(name ? indent + 1 : indent, inNamed, null);
      return;
    }

    // Label and legend text is already the name of the control or group it labels.
    // Keep walking, though: a <label> often wraps its checkbox.
    if (role === "LabelText" || role === "legend") {
      walkChildren(indent, true);
      return;
    }

    if (role === "image" || role === "img") {
      if (name.trim() && !inNamed) push({ indent, kind: "text", text: `image: ${clip(name, MAX_NAME)}` });
      return;
    }

    if (LIVE.has(role)) {
      push({ indent, kind: "struct", text: name ? `${role} ${quote(name, MAX_NAME)}:` : `${role}:` });
      walkChildren(indent + 1, inNamed);
      flush();
      return;
    }

    const isLandmark = LANDMARKS.has(role) || (NAMED_CONTAINERS.has(role) && name.trim() !== "");
    if (isLandmark) {
      push({ indent, kind: "struct", text: name.trim() ? `${role} ${quote(name, MAX_NAME)}:` : `${role}:` });
      walkChildren(indent + 1, inNamed);
      flush();
      return;
    }

    // Transparent container (generic, paragraph, listitem, cell, ...).
    walkChildren(indent, inNamed);
    if (!INLINE.has(role)) flush();
  }

  walk(root, 0, false, null);
  flush();

  const title = str(root?.name?.value) || "(untitled)";
  const header = `PAGE: ${clip(title, 120)} (${opts.url})`;

  // ---- Budgeting ---------------------------------------------------------
  const focusLine = lines.find((l) => l.focused);
  const anchor = focusLine?.order ?? 0;
  const dist = (l: Line) => Math.abs(l.order - anchor);
  for (const l of lines) l.keep = true;

  if (opts.mode === "action") {
    const controls = lines.filter((l) => l.candidate).sort((a, b) => dist(a) - dist(b));
    for (const l of controls.slice(maxCandidates)) l.keep = l.focused ?? false;
  }

  const size = () => lines.reduce((s, l) => s + (l.keep ? l.text.length + l.indent * 2 + 1 : 0), header.length);
  const dropOrder: LineKind[] = ["text", "option", "control", "heading"];
  let total = size();
  for (const kind of dropOrder) {
    if (total <= budget) break;
    const victims = lines
      .filter((l) => l.keep && l.kind === kind && !l.focused)
      .sort((a, b) => dist(b) - dist(a));
    for (const v of victims) {
      if (total <= budget) break;
      v.keep = false;
      total -= v.text.length + v.indent * 2 + 1;
    }
  }

  // Drop containers left with nothing inside them.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.keep || l.kind !== "struct") continue;
    let hasChild = false;
    for (let j = i + 1; j < lines.length && lines[j]!.indent > l.indent; j++) {
      if (lines[j]!.keep) {
        hasChild = true;
        break;
      }
    }
    if (!hasChild) l.keep = false;
  }

  const kept = lines.filter((l) => l.keep);
  const candidates: Candidate[] = [];
  const out = [header];
  for (const l of kept) {
    let text = l.text;
    if (l.candidate) {
      const n = candidates.length + 1;
      candidates.push({ n, ...l.candidate });
      text = `[${n}] ${text}`;
    }
    if (l.focused) text = `>> FOCUSED ${text}`;
    out.push("  ".repeat(l.indent) + text);
  }
  const dropped = lines.length - kept.length;
  if (dropped) out.push(`(${dropped} lines farther from the focus omitted)`);

  const text = out.join("\n");
  return {
    text,
    candidates,
    focused: focusedInfo,
    stats: { nodes: nodes.length, lines: kept.length, dropped, chars: text.length },
  };
}
