import type { EditableField } from "./ghost.js";
import { isSensitiveField, scrubNamedValue, scrubValue } from "../shared/redact.js";

/**
 * The fallback page outline, used when CDP is unavailable - a cross-origin
 * iframe, or the user dismissed Chrome's debugging banner. It is the same shape
 * as the accessibility-tree outline, computed approximately from the DOM so the
 * prompt (and therefore the model's behaviour) stays consistent.
 */

const MAX_CHARS = 3600;
const MAX_CONTROLS = 25;

type Labelable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;

function text(node: Element | null | undefined): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A rough accessible-name computation - the cheap 80% of the real algorithm. */
export function accessibleName(el: Labelable): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const names = labelledBy
      .split(/\s+/)
      .map((id) => text(el.ownerDocument.getElementById(id)))
      .filter(Boolean);
    if (names.length) return names.join(" ");
  }

  if (el.id) {
    const forLabel = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (forLabel) return text(forLabel);
  }

  const wrapping = el.closest("label");
  if (wrapping) return text(wrapping);

  const placeholder = (el as HTMLInputElement).placeholder;
  if (placeholder?.trim()) return placeholder.trim();

  const title = el.getAttribute("title");
  if (title?.trim()) return title.trim();

  return el.getAttribute("name") ?? "";
}

export function roleOfField(el: EditableField): "textbox" | "searchbox" | "combobox" {
  const explicit = el.getAttribute("role");
  if (explicit === "searchbox" || explicit === "combobox") return explicit;
  if (el instanceof HTMLInputElement && el.type === "search") return "searchbox";
  if (el.getAttribute("aria-autocomplete") || el.getAttribute("list")) return "combobox";
  return "textbox";
}

function controlLine(el: Labelable, focused: EditableField): string | null {
  const name = accessibleName(el).slice(0, 120);
  if (el === focused) {
    return `>> FOCUSED ${roleOfField(focused)}${name ? ` "${name}"` : ""}`;
  }

  if (el instanceof HTMLButtonElement) {
    const label = name || text(el);
    return label ? `button "${label}"` : null;
  }
  if (el instanceof HTMLSelectElement) {
    const value = el.selectedOptions[0]?.text ?? "";
    return `combobox "${name}"${value ? ` = ${scrubNamedValue(name, value)}` : ""}`;
  }
  if (isSensitiveField(el)) {
    return name ? `textbox "${name}" = (not read)` : null;
  }

  const role = el instanceof HTMLTextAreaElement ? "textbox" : roleOfField(el);
  const value = el.value ? scrubNamedValue(name, el.value.slice(0, 160)) : "";
  if (!name && !value) return null;
  return `${role}${name ? ` "${name}"` : ""}${value ? ` = ${value}` : ""}`;
}

export function domOutline(field: EditableField): string {
  const lines: string[] = [];
  const doc = field.ownerDocument;

  lines.push(`PAGE: ${document.title.slice(0, 120)} (${location.href.slice(0, 120)})`);

  const headings = [...doc.querySelectorAll("h1, h2, h3")].slice(0, 8);
  for (const heading of headings) {
    const content = text(heading);
    if (content) lines.push(`  heading(${heading.tagName[1]}): ${content.slice(0, 120)}`);
  }

  const container =
    field.closest("form, fieldset, [role='form'], [role='region'], section, article, main") ??
    doc.body;

  const containerName =
    container.getAttribute?.("aria-label") ||
    text(container.querySelector("legend, h1, h2, h3")) ||
    "";
  lines.push(`  form${containerName ? ` "${containerName.slice(0, 80)}"` : ""}:`);

  const controls = [
    ...container.querySelectorAll<Labelable>("input, textarea, select, button"),
  ].slice(0, MAX_CONTROLS);
  if (!controls.includes(field)) controls.unshift(field);

  for (const control of controls) {
    if (control instanceof HTMLInputElement && control.type === "hidden") continue;
    const line = controlLine(control, field);
    if (line) lines.push(`    ${line}`);
  }

  // Surrounding prose is what makes a reply box worth completing at all - and
  // it usually lives outside the form (the thread above the reply), so read
  // from the enclosing main region rather than the form itself.
  const region =
    field.closest("main, article, [role='main'], [role='dialog'], dialog") ?? doc.body;
  const prose = scrubValue((region as HTMLElement).innerText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (prose.length > 40) {
    const room = MAX_CHARS - lines.join("\n").length - 20;
    if (room > 120) lines.push(`  text: ${prose.slice(0, room)}`);
  }

  return lines.join("\n").slice(0, MAX_CHARS);
}

// ---------------------------------------------------- action-mode fallback

const ACTIONABLE = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='combobox']",
].join(", ");

const MAX_ACTION_CANDIDATES = 60;
const MAX_ACTION_CHARS = 5000;

/** The element's role, as the accessibility tree would name it. */
export function roleOfElement(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.split(/\s+/)[0];
  if (el instanceof HTMLButtonElement || el.tagName === "SUMMARY") return "button";
  if (el instanceof HTMLAnchorElement) return "link";
  if (el instanceof HTMLSelectElement) return el.multiple ? "listbox" : "combobox";
  if (el instanceof HTMLTextAreaElement) return "textbox";
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      case "range":
        return "slider";
      case "number":
        return "spinbutton";
      case "search":
        return "searchbox";
      case "submit":
      case "button":
      case "reset":
      case "image":
        return "button";
      default:
        return roleOfField(el);
    }
  }
  return el.tagName.toLowerCase();
}

/** A short human name for any control - labels for fields, text for buttons. */
export function nameOfElement(el: Element): string {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type)) {
      return (el.value || accessibleName(el)).trim().slice(0, 80);
    }
    return accessibleName(el).slice(0, 80);
  }
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim().slice(0, 80);
  const own = text(el);
  if (own) return own.slice(0, 80);
  const img = el.querySelector("img[alt]");
  if (img) return (img.getAttribute("alt") ?? "").trim().slice(0, 80);
  return (el.getAttribute("title") ?? "").trim().slice(0, 80);
}

function isActionable(el: Element): boolean {
  if (el.closest("[data-carat]")) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  if (el.closest("[aria-hidden='true'], [inert]")) return false;
  if (!el.getClientRects().length) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

function actionLine(el: Element, focused: Element | null): string {
  const role = roleOfElement(el);
  const name = nameOfElement(el);
  let line = `${role}${name ? ` "${name}"` : ""}`;

  if (el instanceof HTMLSelectElement) {
    const current = el.selectedOptions[0]?.text.trim();
    if (current) line += ` = ${scrubNamedValue(name, current)}`;
  } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    line += el.checked ? " = checked" : " = unchecked";
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (isSensitiveField(el)) line += " = (not read)";
    else if (el.value) line += ` = ${scrubNamedValue(name, el.value.replace(/\s+/g, " ").slice(0, 200))}`;
  }
  return el === focused ? `>> FOCUSED ${line}` : line;
}

export interface ActionOutline {
  text: string;
  /** candidates[n - 1] is the element labelled [n] in the text. */
  candidates: Element[];
}

/**
 * Numbered outline of everything the user could do next, built from the DOM.
 * Same shape as the accessibility-tree version, so the model sees one format
 * whichever source produced it.
 *
 * When there are more controls than fit, the ones near where the user is
 * working win: same form or section first, then whatever is on screen.
 */
export function domActionOutline(anchor: Element | null): ActionOutline {
  const doc = document;
  const focused = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
  const near =
    anchor?.closest("form, fieldset, [role='form'], [role='dialog'], dialog, section, article, main") ??
    null;

  const all = [...doc.querySelectorAll(ACTIONABLE)].filter(isActionable);
  const scored = all.map((el, order) => {
    let score = 0;
    if (near && near.contains(el)) score += 4;
    if (inViewport(el)) score += 2;
    if (el === focused) score += 8;
    return { el, order, score };
  });
  const chosen = scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_ACTION_CANDIDATES)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.el);

  const lines: string[] = [`PAGE: ${document.title.slice(0, 120)} (${location.href.slice(0, 120)})`];
  for (const heading of [...doc.querySelectorAll("h1, h2, h3")].slice(0, 6)) {
    const content = text(heading);
    if (content) lines.push(`  heading(${heading.tagName[1]}): ${content.slice(0, 120)}`);
  }

  const candidates: Element[] = [];
  for (const el of chosen) {
    candidates.push(el);
    const n = candidates.length;
    const line = actionLine(el, focused);
    lines.push(
      "  " +
        (line.startsWith(">> FOCUSED ")
          ? line.replace(">> FOCUSED ", `>> FOCUSED [${n}] `)
          : `[${n}] ${line}`),
    );
    if (el instanceof HTMLSelectElement) {
      for (const option of [...el.options].slice(0, 8)) {
        lines.push(`      option "${option.text.trim().slice(0, 60)}"`);
      }
    }
  }

  const prose = scrubValue(((near ?? doc.querySelector("main") ?? doc.body) as HTMLElement).innerText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const used = lines.join("\n").length;
  if (prose.length > 40 && MAX_ACTION_CHARS - used > 200) {
    lines.push(`  text: ${prose.slice(0, MAX_ACTION_CHARS - used - 20)}`);
  }

  return { text: lines.join("\n").slice(0, MAX_ACTION_CHARS), candidates };
}
