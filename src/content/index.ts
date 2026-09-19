import {
  PORT_NAME,
  TARGET_EVENT,
  IRREVERSIBLE,
  type FieldInfo,
  type WorkerToContent,
  type AxSource,
  type ActionMessage,
  type ActionKind,
} from "../shared/types.js";
import { GhostRenderer, type EditableField } from "./ghost.js";
import { ActionOverlay } from "./action-overlay.js";
import {
  domOutline,
  domActionOutline,
  roleOfField,
  roleOfElement,
  nameOfElement,
  accessibleName,
} from "./snapshot.js";
import { Hud } from "./hud.js";
import { isSensitiveField } from "../shared/redact.js";

/**
 * Two kinds of suggestion share one Tab key:
 *
 *   text   - ghost text after the caret while you type (the original mode)
 *   action - a highlighted control you are likely to use next: a button to
 *            click, a field to move to, a dropdown option to pick
 *
 * Only one is ever on screen. Text wins while you are typing; an action is
 * predicted when the text model has nothing to add, or after you click or
 * change something.
 */

const COMPLETABLE_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", ""]);
const MIN_CHARS = 2;
/** Pause after an interaction before predicting what comes next. */
const PREDICT_SETTLE_MS = 600;
/** How long an armed irreversible action waits for its second Tab. */
const ARM_WINDOW_MS = 3000;

const ghost = new GhostRenderer();
const overlay = new ActionOverlay();
const hud = new Hud();

let port: chrome.runtime.Port | null = null;
let enabled = true;
let predictEnabled = true;
let axSource: AxSource = "none";
let debounceMs = 280;

// --- text state
let field: EditableField | null = null;
/** The field text the current suggestion was generated for. */
let baseValue = "";
let suggestion = "";
let reqId: string | null = null;
let timer = 0;
let composing = false;
/** Value the user explicitly dismissed with Escape - do not re-suggest for it. */
let dismissedAt: string | null = null;
let suppressNextInput = false;
/** Value when the field gained focus, to log "typed in X" only if it changed. */
let valueAtFocus = "";

// --- action state
interface ActiveAction {
  el: Element;
  kind: ActionKind;
  value: string;
  label: string;
  irreversible: boolean;
  armed: boolean;
}

let action: ActiveAction | null = null;
let predictReqId: string | null = null;
let predictTimer = 0;
let armTimer = 0;
/** Elements the worker pointed at through CDP, keyed by request id. */
const pointed = new Map<string, Element>();
/** Fallback-outline candidates for the in-flight prediction. */
let fallbackCandidates: { reqId: string; elements: Element[] } | null = null;
/** Labels dismissed with Escape on this page - not offered again. */
const dismissedActions = new Set<string>();

// ---------------------------------------------------------------- transport

function connect(): chrome.runtime.Port {
  if (port) return port;
  const next = chrome.runtime.connect({ name: PORT_NAME });
  next.onMessage.addListener(onMessage);
  next.onDisconnect.addListener(() => {
    port = null;
  });
  port = next;
  return next;
}

function send(message: Parameters<chrome.runtime.Port["postMessage"]>[0]): void {
  try {
    connect().postMessage(message);
  } catch {
    // Service worker recycled mid-send; the next attempt reconnects.
    port = null;
  }
}

function log(entry: string): void {
  send({ type: "log", entry });
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function onMessage(message: WorkerToContent): void {
  switch (message.type) {
    case "delta":
      if (message.reqId !== reqId || !field) return;
      suggestion += message.text;
      clearAction();
      render();
      break;

    case "done":
      if (message.reqId !== reqId) return;
      hud.update({ stats: message.stats, axSource: message.stats.axSource, error: null });
      if (message.stats.axSource !== "none") axSource = message.stats.axSource;
      // The text model had nothing to add: the user has finished this thought,
      // so the useful suggestion is what they do next.
      if (!suggestion && message.stats.prompt && field && field.value.trim().length >= 3) {
        schedulePrediction(150);
      }
      break;

    case "action":
      onAction(message);
      break;

    case "error":
      if (message.reqId !== reqId && message.reqId !== predictReqId) return;
      if (message.reqId === reqId) clearSuggestion();
      hud.update({ error: message.message });
      if (message.fatal) console.warn("[carat]", message.message);
      break;

    case "state":
      enabled = message.enabled;
      predictEnabled = message.predictActions;
      axSource = message.axSource;
      hud.update({
        enabled: message.enabled,
        model: message.model,
        axSource: message.axSource,
        session: message.session,
      });
      if (!enabled) {
        clearSuggestion();
        clearAction();
      }
      if (!predictEnabled) clearAction();
      break;
  }
}

// ------------------------------------------------------------------ helpers

function completable(el: EventTarget | null): el is EditableField {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    const type = (el.type || "text").toLowerCase();
    return COMPLETABLE_INPUT_TYPES.has(type) && !el.readOnly && !el.disabled;
  }
  return false;
}

function caretAtEnd(el: EditableField): boolean {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start == null || end == null) return true; // some inputs do not expose a selection
  return start === end && end === el.value.length;
}

function render(): void {
  if (!field || !suggestion) {
    ghost.clear();
    return;
  }
  ghost.show(field, suggestion);
}

function clearSuggestion(): void {
  suggestion = "";
  reqId = null;
  ghost.clear();
}

function describe(el: EditableField): FieldInfo {
  const multiline = el instanceof HTMLTextAreaElement;
  const maxLength = el.maxLength > 0 ? el.maxLength : null;
  return {
    role: multiline ? "textbox" : roleOfField(el),
    name: accessibleName(el).slice(0, 120),
    placeholder: (el as HTMLInputElement).placeholder ?? "",
    multiline,
    maxLength,
    inputType: multiline ? "textarea" : (el as HTMLInputElement).type || "text",
    typed: el.value.slice(0, el.selectionStart ?? el.value.length),
    trailing: el.value.slice(el.selectionEnd ?? el.value.length),
  };
}

/** "clicked button "Send reply"" - the unit of history the predictor reads. */
function describeElement(el: Element): string {
  const name = nameOfElement(el);
  return `${roleOfElement(el)}${name ? ` "${name}"` : ""}`;
}

const INTERACTIVE =
  "button, a[href], summary, input, select, textarea, [role='button'], [role='link'], " +
  "[role='checkbox'], [role='radio'], [role='switch'], [role='tab'], [role='menuitem'], [role='option']";

// ------------------------------------------------------------ text requests

function schedule(force = false): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => request(force), force ? 0 : debounceMs);
}

function request(force: boolean): void {
  if (!enabled || !field || composing) return;
  if (isSensitiveField(field)) return;
  if (!caretAtEnd(field)) return;

  const value = field.value;
  if (!force && value.length < MIN_CHARS) return;
  if (!force && dismissedAt === value) return;

  const info = describe(field);
  reqId = newId();
  baseValue = value;
  suggestion = "";
  ghost.clear();

  send({
    type: "suggest",
    reqId,
    field: info,
    url: location.href,
    title: document.title,
    // Only pay for the DOM walk when the worker is not getting a real AX tree.
    fallbackOutline: axSource === "cdp" ? "" : domOutline(field),
    topFrame: window.top === window,
  });
}

/**
 * When the user types the next character of the suggestion, trim the ghost
 * locally instead of asking for a new one. Most keystrokes inside an accepted
 * suggestion then cost nothing at all, which is most of why this feels instant.
 */
function tryPrefixReuse(value: string): boolean {
  if (!suggestion || !value.startsWith(baseValue)) return false;
  const typedSince = value.slice(baseValue.length);
  if (!typedSince || typedSince.length > suggestion.length) return false;
  if (!suggestion.startsWith(typedSince)) return false;

  suggestion = suggestion.slice(typedSince.length);
  baseValue = value;
  hud.countLocalHit();
  if (!suggestion) {
    ghost.clear();
    return false; // exhausted - go get more
  }
  render();
  return true;
}

// -------------------------------------------------------------- text accept

/** setSelectionRange throws on type=email/number; those fields keep the caret where it is. */
function moveCaret(el: EditableField, position: number): void {
  try {
    el.setSelectionRange(position, position);
  } catch {
    /* input type without selection support */
  }
}

function setNativeValue(el: EditableField, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function accept(): void {
  if (!field || !suggestion) return;
  const el = field;
  const text = suggestion;

  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;

  let inserted = false;
  try {
    // Preferred: keeps the page's undo stack and fires a trusted input event,
    // which is what frameworks are actually listening for.
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    // React tracks the last value it wrote on the DOM node and swallows events
    // whose value it thinks it already knows - write through the native setter
    // so its tracker sees a change.
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setNativeValue(el, next);
    moveCaret(el, start + text.length);
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
    );
  }

  send({ type: "accepted", chars: text.length });
  suppressNextInput = true;
  clearSuggestion();
  baseValue = el.value;
  dismissedAt = null;
  // Cursor-style chaining: accepting one suggestion should tee up the next.
  schedule();
}

// ---------------------------------------------------------- action requests

function schedulePrediction(delay = PREDICT_SETTLE_MS): void {
  clearTimeout(predictTimer);
  predictTimer = window.setTimeout(predict, delay);
}

function cancelPrediction(): void {
  clearTimeout(predictTimer);
  if (predictReqId) send({ type: "cancel", reqId: predictReqId });
  predictReqId = null;
}

function predict(): void {
  if (!enabled || !predictEnabled || composing) return;
  if (suggestion) return; // text is already on offer
  if (document.visibilityState !== "visible") return;

  const current = field && completable(field) && !isSensitiveField(field) ? field : null;
  predictReqId = newId();

  let fallbackOutline = "";
  if (axSource !== "cdp" || window.top !== window) {
    const built = domActionOutline(current ?? document.activeElement);
    fallbackOutline = built.text;
    fallbackCandidates = { reqId: predictReqId, elements: built.candidates };
  }

  send({
    type: "predict",
    reqId: predictReqId,
    url: location.href,
    title: document.title,
    field: current ? describe(current) : null,
    fallbackOutline,
    topFrame: window.top === window,
  });
}

function onAction(message: ActionMessage): void {
  if (message.reqId !== predictReqId) return;
  predictReqId = null;
  if (message.stats.axSource !== "none") axSource = message.stats.axSource;
  hud.update({ stats: message.stats, error: null });

  const predicted = message.action;
  const el =
    predicted &&
    (message.resolve === "event"
      ? pointed.get(message.reqId)
      : fallbackCandidates?.reqId === message.reqId
        ? fallbackCandidates.elements[predicted.target - 1]
        : undefined);
  pointed.delete(message.reqId);

  if (!predicted || !el || !el.isConnected) {
    hud.update({ action: predicted ? "(target not found)" : "none" });
    return;
  }
  hud.update({
    action: `${predicted.kind} ${predicted.label} (${predicted.confidence.toFixed(2)})`,
  });

  // Something newer is on screen, or the user already said no to this one.
  if (suggestion || dismissedActions.has(predicted.label)) return;

  action = {
    el,
    kind: predicted.kind,
    value: predicted.value,
    label: predicted.label,
    // Belt and braces: re-check against the element's own name on this side.
    irreversible:
      predicted.irreversible ||
      (predicted.kind === "click" && IRREVERSIBLE.test(nameOfElement(el))),
    armed: false,
  };
  showAction();
}

function showAction(): void {
  if (!action) return;
  overlay.show(action.el, {
    label: action.label,
    irreversible: action.irreversible,
    armed: action.armed,
    preview: action.kind === "focus" && action.value ? action.value.slice(0, 40) : undefined,
  });
}

function clearAction(): void {
  clearTimeout(armTimer);
  if (!action) return;
  action = null;
  overlay.clear();
}

function joinValue(existing: string, addition: string): string {
  if (existing && !/\s$/.test(existing) && !/^\s/.test(addition)) return ` ${addition}`;
  return addition;
}

function selectOption(el: Element, value: string): void {
  if (el instanceof HTMLSelectElement) {
    const want = value.trim().toLowerCase();
    const options = [...el.options];
    const option =
      options.find((o) => o.text.trim().toLowerCase() === want) ??
      options.find((o) => o.value.toLowerCase() === want) ??
      options.find((o) => o.text.toLowerCase().includes(want));
    if (!option) return;
    el.focus({ preventScroll: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (setter) setter.call(el, option.value);
    else el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  // A custom dropdown: open it; the next prediction can pick the option.
  (el as HTMLElement).click();
}

function executeAction(): void {
  const current = action;
  if (!current) return;
  clearAction();
  send({ type: "action-accepted" });

  const el = current.el as HTMLElement;
  if (!el.isConnected) return;
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });

  switch (current.kind) {
    case "click":
      el.focus?.({ preventScroll: true });
      // The click listener below logs it and predicts what follows.
      el.click();
      break;

    case "focus":
      el.focus({ preventScroll: true });
      if (completable(el)) {
        field = el;
        moveCaret(el, el.value.length);
        if (current.value) {
          // Arrive with the predicted text already waiting as ghost text.
          baseValue = el.value;
          suggestion = joinValue(el.value, current.value);
          reqId = newId();
          render();
        }
      }
      break;

    case "select":
      selectOption(el, current.value);
      break;
  }
}

// ------------------------------------------------------------------- events

// The worker points at a predicted element by dispatching an event on it.
window.addEventListener(
  TARGET_EVENT,
  (event) => {
    const id = (event as CustomEvent).detail;
    const target = event.composedPath()[0];
    if (typeof id === "string" && target instanceof Element) pointed.set(id, target);
  },
  true,
);

document.addEventListener(
  "focusin",
  (event) => {
    const target = event.target;
    if (!completable(target)) {
      if (field) clearSuggestion();
      field = null;
      return;
    }
    field = target;
    baseValue = target.value;
    valueAtFocus = target.value;
    dismissedAt = null;
    clearSuggestion();
  },
  true,
);

document.addEventListener(
  "focusout",
  (event) => {
    clearTimeout(timer);
    const target = event.target;
    if (completable(target) && target.value !== valueAtFocus && !isSensitiveField(target)) {
      log(`typed in ${describeElement(target)}`);
    }
    clearSuggestion();
    field = null;
  },
  true,
);

document.addEventListener(
  "input",
  (event) => {
    if (!completable(event.target) || event.target !== field) return;
    if (suppressNextInput) {
      suppressNextInput = false;
      return;
    }
    if (composing || !enabled) return;

    // Typing means they are not about to click the thing we highlighted.
    clearAction();
    cancelPrediction();

    const value = field.value;
    if (dismissedAt !== null && value !== dismissedAt) dismissedAt = null;

    if (tryPrefixReuse(value)) return;

    clearSuggestion();
    schedule();
  },
  true,
);

document.addEventListener("compositionstart", () => {
  composing = true;
  clearSuggestion();
  clearAction();
});
document.addEventListener("compositionend", () => {
  composing = false;
  schedule();
});

// Clicks and changes are the history the predictor reasons from.
document.addEventListener(
  "click",
  (event) => {
    const target = event.target instanceof Element ? event.target.closest(INTERACTIVE) : null;
    if (!target || target.closest("[data-carat]")) return;
    // Clicking into a text field means they are about to type; text mode has it.
    if (completable(target)) return;
    // Checkboxes and selects are logged by their change event instead.
    if (target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type)) return;
    if (target instanceof HTMLSelectElement) return;
    log(`clicked ${describeElement(target)}`);
    schedulePrediction();
  },
  true,
);

document.addEventListener(
  "change",
  (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement) {
      const chosen = target.selectedOptions[0]?.text.trim() ?? "";
      log(`selected "${chosen}" in ${describeElement(target)}`);
      schedulePrediction();
    } else if (target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type)) {
      log(`${target.checked ? "checked" : "unchecked"} ${describeElement(target)}`);
      schedulePrediction();
    }
  },
  true,
);

document.addEventListener(
  "mousedown",
  (event) => {
    // Clicking anywhere is its own decision; the highlight has had its chance.
    if (action && !(event.target instanceof Element && action.el.contains(event.target))) {
      clearAction();
    }
  },
  true,
);

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

document.addEventListener(
  "keydown",
  (event) => {
    // Ctrl+. forces a suggestion: text if you are in a field, else an action.
    // Ctrl+Shift+. toggles the HUD.
    if (event.ctrlKey && event.code === "Period") {
      event.preventDefault();
      if (event.shiftKey) hud.toggle();
      else if (field && field.value.trim()) schedule(true);
      else {
        clearAction();
        schedulePrediction(0);
      }
      return;
    }

    // --- text suggestion
    if (field && event.target === field && suggestion) {
      if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Capture phase + stopImmediatePropagation, or the page moves focus
        // before we ever see the key.
        event.preventDefault();
        event.stopImmediatePropagation();
        accept();
        return;
      }
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        dismissedAt = field.value;
        clearTimeout(timer);
        clearSuggestion();
        send({ type: "rejected" });
        return;
      }
      if (
        event.key.startsWith("Arrow") ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Backspace" ||
        event.key === "Delete" ||
        event.key === "Enter"
      ) {
        clearSuggestion();
      }
      return;
    }

    // --- action suggestion
    if (action) {
      if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (action.irreversible && !action.armed) {
          // First Tab only arms it. A reflexive Tab must never send or pay -
          // and nobody should confirm a button they cannot see, so bring it
          // on screen before asking for the second Tab.
          action.armed = true;
          action.el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          showAction();
          clearTimeout(armTimer);
          armTimer = window.setTimeout(() => {
            if (action) {
              action.armed = false;
              showAction();
            }
          }, ARM_WINDOW_MS);
        } else {
          executeAction();
        }
        return;
      }
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        dismissedActions.add(action.label);
        log(`dismissed suggestion "${action.label}"`);
        clearAction();
        return;
      }
      if (!MODIFIER_KEYS.has(event.key)) clearAction();
    }
  },
  true,
);

// A click can move the caret off the end, which invalidates the ghost.
document.addEventListener(
  "mouseup",
  () => {
    if (field && suggestion && !caretAtEnd(field)) clearSuggestion();
  },
  true,
);

addEventListener("pagehide", () => {
  clearAction();
  cancelPrediction();
});

chrome.storage.local.get({ debounceMs: 280 }).then((stored) => {
  debounceMs = (stored as { debounceMs: number }).debounceMs;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.debounceMs) debounceMs = changes.debounceMs.newValue;
});

connect();
if (window.top === window) log(`opened "${document.title.slice(0, 80)}"`);
