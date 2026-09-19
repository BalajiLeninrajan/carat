import { PORT_NAME, TARGET_EVENT, type ActionKind, type ContentToWorker, type FieldInfo, type WorkerToContent } from "../shared/protocol.js";
import { isSensitiveField, maskSensitive } from "../shared/redact.js";
import { Ghost } from "./ghost.js";
import { Ring } from "./ring.js";

/** How long the user must be still, after interacting, before Carat looks at the page. */
const IDLE_MS = 500;
/** Shorter pause while typing: ghost text has to feel instant, and it uses the cached tree. */
const TYPING_IDLE_MS = 250;

// ---------------------------------------------------------------------------
// Port to the worker. It drops whenever the service worker is recycled, so
// reconnect lazily on the next send.

let port: chrome.runtime.Port | null = null;

function post(msg: ContentToWorker): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!port) {
        port = chrome.runtime.connect({ name: PORT_NAME });
        port.onMessage.addListener(onWorkerMessage);
        port.onDisconnect.addListener(() => {
          // Reading lastError marks it handled (e.g. "moved into back/forward cache").
          void chrome.runtime.lastError;
          port = null;
        });
      }
      port.postMessage(msg);
      return;
    } catch {
      // Disconnected, or the extension was reloaded and this context is orphaned.
      port = null;
    }
  }
}

// Close the port ourselves when the page is hidden, so Chrome does not have to
// force-close it on the way into the back/forward cache. post() reconnects if
// the page is restored.
addEventListener("pagehide", () => {
  sendSeen();
  port?.disconnect();
  port = null;
});

// ---------------------------------------------------------------------------
// Text fields

type TextField = HTMLInputElement | HTMLTextAreaElement;
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number", ""]);

function asTextField(el: Element | null): TextField | null {
  if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
  if (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) {
    return el.readOnly || el.disabled ? null : el;
  }
  return null;
}

/** document.activeElement, looking through open shadow roots. */
function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Rough accessible name. The worker uses the AX tree's real one where it can. */
function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return clip(aria, 60);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (text.trim()) return clip(text, 60);
  }
  if ((el as TextField).labels?.length) return clip((el as TextField).labels![0].textContent ?? "", 60);
  if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type)) return clip(el.value, 60);
  const text = (el as HTMLElement).innerText;
  if (text?.trim()) return clip(text, 60);
  const alt = el.querySelector("img[alt]")?.getAttribute("alt");
  if (alt) return clip(alt, 60);
  return clip(el.getAttribute("title") ?? el.getAttribute("placeholder") ?? el.getAttribute("name") ?? "", 60);
}

function fieldInfo(el: TextField): FieldInfo {
  const redacted = isSensitiveField(el);
  // Some input types (email, number) do not expose a selection; treat the caret as at the end.
  let caret = el.value.length;
  try {
    if (el.selectionStart != null) caret = el.selectionStart;
  } catch {}
  return {
    tag: el instanceof HTMLTextAreaElement ? "textarea" : "input",
    inputType: el instanceof HTMLTextAreaElement ? "textarea" : el.type || "text",
    multiline: el instanceof HTMLTextAreaElement,
    name: accessibleName(el),
    placeholder: el.placeholder ?? "",
    maxLength: el.maxLength > 0 ? el.maxLength : null,
    typed: redacted ? "" : el.value.slice(0, caret),
    trailing: redacted ? "" : el.value.slice(caret),
    redacted,
  };
}

// ---------------------------------------------------------------------------
// Interaction history

const CLICKABLE =
  'a[href], button, summary, select, input:not([type=hidden]), textarea, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=checkbox], [role=radio], [role=switch], [role=treeitem], [onclick]';

function roleName(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  if (el instanceof HTMLAnchorElement) return "link";
  if (el instanceof HTMLButtonElement || el.tagName === "SUMMARY") return "button";
  if (el instanceof HTMLSelectElement) return "combobox";
  if (el instanceof HTMLTextAreaElement) return "textbox";
  if (el instanceof HTMLInputElement) {
    if (["submit", "button", "reset", "image"].includes(el.type)) return "button";
    if (el.type === "checkbox" || el.type === "radio") return el.type;
    return el.type === "search" ? "searchbox" : "textbox";
  }
  return el.tagName.toLowerCase();
}

function log(entry: string): void {
  post({ type: "log", entry, url: location.href });
}

function describe(el: Element): string {
  const name = accessibleName(el);
  return name ? `${roleName(el)} "${name}"` : roleName(el);
}

/** Value of the focused field when it gained focus, to log "typed into" on blur. */
let focusValue: { el: TextField; value: string } | null = null;

document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted) return;
    const target = (e.composedPath()[0] as Element | undefined)?.closest?.(CLICKABLE);
    if (!target || asTextField(target) || target instanceof HTMLSelectElement) return;
    // Checkbox/radio clicks are logged by their change event.
    if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) return;
    if (target instanceof HTMLLabelElement && target.control) return;
    log(`clicked ${describe(target)}`);
  },
  true,
);

document.addEventListener(
  "change",
  (e) => {
    const el = e.target;
    if (el instanceof HTMLSelectElement) {
      log(`selected "${clip(el.selectedOptions[0]?.text ?? el.value, 60)}" in combobox "${accessibleName(el)}"`);
    } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      log(`${el.checked ? "checked" : "unchecked"} ${el.type} "${accessibleName(el)}"`);
    }
  },
  true,
);

document.addEventListener(
  "focusin",
  () => {
    const f = asTextField(deepActiveElement());
    focusValue = f ? { el: f, value: f.value } : null;
  },
  true,
);

document.addEventListener(
  "focusout",
  (e) => {
    const el = e.target as Element;
    if (ghostState?.el === el) clearGhost();
    if (!focusValue || focusValue.el !== el) return;
    const { el: f, value: before } = focusValue;
    focusValue = null;
    if (f.value === "" || f.value === before) return;
    if (isSensitiveField(f)) log(`typed into ${describe(f)} (redacted)`);
    else log(`typed into ${describe(f)}: "${clip(f.value, 60)}"`);
  },
  true,
);

// ---------------------------------------------------------------------------
// Action suggestions

const ring = new Ring();

interface Suggestion {
  reqId: number;
  el: Element;
  /** Kind/label/irreversible have arrived; it can be accepted. */
  ready: boolean;
  kind: ActionKind;
  value: string;
  irreversible: boolean;
  armed: boolean;
  /** Tab while the target was offscreen scrolled it into view instead of acting. */
  scrolled: boolean;
}
let suggestion: Suggestion | null = null;
let disarmTimer: ReturnType<typeof setTimeout> | undefined;

/** The element the worker last dispatched TARGET_EVENT on (always just before a "target" message). */
let lastTarget: Element | null = null;
document.addEventListener(TARGET_EVENT, (e) => (lastTarget = e.composedPath()[0] as Element), true);

function clearSuggestion(): void {
  suggestion = null;
  clearTimeout(disarmTimer);
  ring.hide();
}

// ---------------------------------------------------------------------------
// Ghost text

const ghost = new Ghost();

interface GhostState {
  reqId: number;
  el: TextField;
  /** Field text the suggestion continues. */
  base: string;
  /** The whole suggestion so far (grows while streaming). */
  text: string;
  /** How much of `text` the user has since typed themselves. */
  consumed: number;
  done: boolean;
}
let ghostState: GhostState | null = null;

function clearGhost(): void {
  ghostState = null;
  ghost.hide();
}

function remaining(g: GhostState): string {
  return g.text.slice(g.consumed);
}

function renderGhost(): void {
  const g = ghostState;
  if (!g) return ghost.hide();
  const f = g.el;
  const atEnd = f.selectionStart === f.value.length && f.selectionEnd === f.value.length;
  const intact = f.value === g.base + g.text.slice(0, g.consumed);
  if (asTextField(deepActiveElement()) !== f || !atEnd || !intact || !remaining(g)) return ghost.hide();
  ghost.show(f, remaining(g));
}

/**
 * The user typed into the field while a suggestion was showing. If they typed
 * exactly what it suggested, advance through it locally: no new request.
 * Returns false when the suggestion no longer applies.
 */
function advanceGhost(): boolean {
  const g = ghostState;
  if (!g) return false;
  const f = g.el;
  const full = g.base + g.text;
  const typedAlong = f.value.length > g.base.length + g.consumed && f.value.startsWith(g.base) && full.startsWith(f.value);
  if (!typedAlong) return false;
  g.consumed = f.value.length - g.base.length;
  if (g.done && !remaining(g)) return false;
  renderGhost();
  return true;
}

/** Insert text at the caret the way typing would, so frameworks and undo see it. */
function insertText(f: TextField, text: string): void {
  f.focus();
  if (document.execCommand("insertText", false, text)) return;
  // execCommand unavailable: write through the native setter (React tracks
  // .value writes made through its own setter and would otherwise revert us).
  const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(f, f.value + text);
  f.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  onFieldInput(); // the synthetic event above is untrusted, so onActivity skips it
}

function acceptGhost(g: GhostState, wordOnly: boolean): void {
  const rest = remaining(g);
  const chunk = wordOnly ? (/^\s*\S+/.exec(rest)?.[0] ?? rest) : rest;
  insertText(g.el, chunk);
}

function onWorkerMessage(msg: WorkerToContent): void {
  if (msg.type === "result") {
    if (!suggestion || suggestion.reqId !== msg.reqId) return;
    if (msg.ok) {
      clearSuggestion();
      // Chain: look for the next step once the page settles. (Clicks also do
      // this through their own trusted events; selects and focus might not.)
      schedule("accept");
    } else {
      ring.flash(msg.reason ?? "Could not do that.");
      const failed = suggestion;
      setTimeout(() => suggestion === failed && clearSuggestion(), 1500);
    }
    return;
  }
  // Replies to an older idle: the user has moved on since.
  if (msg.reqId !== activity) return;
  switch (msg.type) {
    case "target":
      if (!lastTarget?.isConnected) return;
      suggestion = { reqId: msg.reqId, el: lastTarget, ready: false, kind: "click", value: "", irreversible: false, armed: false, scrolled: false };
      ring.show(lastTarget);
      break;
    case "action":
      if (!suggestion || suggestion.reqId !== msg.reqId) return;
      suggestion.ready = true;
      suggestion.kind = msg.kind;
      suggestion.value = msg.value;
      suggestion.irreversible = msg.irreversible;
      ring.setAction({ kind: msg.kind, label: msg.label, value: msg.value, irreversible: msg.irreversible });
      break;
    case "clear":
      if (suggestion?.reqId === msg.reqId) clearSuggestion();
      break;
    case "ghost": {
      // More of a suggestion already showing (the user may have typed along it since).
      if (ghostState?.reqId === msg.reqId && ghostState.base === msg.base) {
        ghostState.text = msg.text;
        ghostState.done = msg.done;
        if (!advanceGhost()) renderGhost();
        break;
      }
      const f = asTextField(deepActiveElement());
      if (!f || f.value !== msg.base) return;
      if (!msg.text) return clearGhost();
      {
        ghostState = { reqId: msg.reqId, el: f, base: msg.base, text: msg.text, consumed: 0, done: msg.done };
      }
      renderGhost();
      break;
    }
  }
}

// The accept key is a tap of the right Shift key: pressed and released with
// nothing else in between, so holding it to type a capital never accepts.
// Esc dismisses; Ctrl+→ accepts one word of ghost text.
let rightShiftTap = false;

function ghostVisible(): GhostState | null {
  const g = ghostState;
  return g && remaining(g) && ghost.element?.style.display !== "none" ? g : null;
}

/** Accept whatever is on offer. Returns false if there was nothing to accept. */
function acceptCurrent(): boolean {
  // Ghost text takes precedence over an action suggestion.
  const g = ghostVisible();
  if (g) {
    acceptGhost(g, false);
    return true;
  }
  const s = suggestion;
  if (!s?.ready) return false;
  // Nobody should act on a control they cannot see: the first tap brings it into view.
  if (ring.offscreen() && !s.scrolled) {
    s.scrolled = true;
    s.el.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }
  // Irreversible actions take a second tap within 3 seconds.
  if (s.irreversible && !s.armed) {
    s.armed = true;
    ring.setArmed(true);
    s.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    clearTimeout(disarmTimer);
    disarmTimer = setTimeout(() => {
      if (suggestion !== s) return;
      s.armed = false;
      ring.setArmed(false);
    }, 3000);
    return true;
  }
  clearTimeout(disarmTimer);
  if (s.kind === "fill" && fillLocally(s)) return true;
  post({ type: "accept", reqId: s.reqId });
  return true;
}

/**
 * "fill": jump to the field and offer the value as ghost text, so accepting
 * it is one more tap (and the user sees it before it goes in). Returns false
 * for targets that are not plain text fields; the worker focuses those.
 */
function fillLocally(s: Suggestion): boolean {
  const f = asTextField(s.el);
  if (!f) return false;
  clearSuggestion();
  f.focus(); // fires focusin, which counts as activity: set the ghost up after it
  try {
    f.setSelectionRange(f.value.length, f.value.length);
  } catch {}
  log(`jumped to ${describe(f)}`);
  const current = f.value;
  if (current && !s.value.toLowerCase().startsWith(current.toLowerCase())) return true;
  const text = s.value.slice(current.length);
  if (!text) return true;
  ghostState = { reqId: activity, el: f, base: current, text, consumed: 0, done: true };
  renderGhost();
  return true;
}

// Registered before the activity listeners below, so that when it swallows a
// key (stopImmediatePropagation) the keypress does not count as activity.
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted) return;
    if (e.code === "ShiftRight") {
      if (!e.repeat) rightShiftTap = !e.ctrlKey && !e.altKey && !e.metaKey;
      return;
    }
    rightShiftTap = false;
    if (e.isComposing) return;

    const g = ghostVisible();
    if (g) {
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        e.stopImmediatePropagation();
        acceptGhost(g, true);
        return;
      }
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        clearGhost();
        return;
      }
    }

    const s = suggestion;
    if (s && e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (s.ready) post({ type: "dismiss", reqId: s.reqId });
      clearSuggestion();
    }
  },
  true,
);

document.addEventListener(
  "keyup",
  (e) => {
    if (!e.isTrusted || e.code !== "ShiftRight") return;
    const tap = rightShiftTap;
    rightShiftTap = false;
    if (tap && acceptCurrent()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);

// Shift-clicking is not a tap either.
document.addEventListener("pointerdown", () => (rightShiftTap = false), true);

// ---------------------------------------------------------------------------
// Idle detection

let idleTimer: ReturnType<typeof setTimeout> | undefined;
let lastReason = "";
/** Bumped on every user interaction; idle messages carry it as their reqId. */
let activity = 0;
/** DOM mutated, or a non-focused control changed, since the last idle message. */
let pageChanged = true;

function schedule(reason: string): void {
  lastReason = reason;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(onIdle, reason === "input" ? TYPING_IDLE_MS : IDLE_MS);
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

/** Typing in a field: ride along an existing suggestion, or start a new request. */
function onFieldInput(): void {
  if (advanceGhost()) return;
  clearGhost();
  activity++;
  if (suggestion) clearSuggestion();
  schedule("input");
}

function onActivity(e: Event): void {
  if (!e.isTrusted) return;
  if (e.type === "keydown") {
    const k = e as KeyboardEvent;
    if (MODIFIER_KEYS.has(k.key)) return;
    // A character key: the input event that follows decides (it may just be
    // typing along the ghost text, which must not cancel it).
    if (ghostState && k.key.length === 1 && !k.ctrlKey && !k.metaKey && !k.altKey) return;
  }
  if ((e as InputEvent).isComposing) {
    // IME composition in progress: wait for it to finish.
    clearGhost();
    clearTimeout(idleTimer);
    return;
  }
  if (e.type === "input" && asTextField(e.target as Element)) return onFieldInput();
  clearGhost();
  activity++;
  // Any interaction makes a showing suggestion stale. (Accepting one is an
  // interaction too: the click it performs lands here.)
  if (suggestion) clearSuggestion();
  // Typing in the focused field is not a page change: its value is sent with the
  // idle message. Anything else that changes values (checkboxes, selects) is.
  if (e.type === "change") pageChanged = true;
  schedule(e.type);
}

function onIdle(): void {
  if (document.visibilityState !== "visible") return;
  const f = asTextField(deepActiveElement());
  post({
    type: "idle",
    reqId: activity,
    url: location.href,
    title: document.title,
    pageChanged,
    reason: lastReason,
    field: f ? fieldInfo(f) : null,
  });
  pageChanged = false;
}

for (const type of ["keydown", "input", "pointerdown", "click", "change", "focusin"]) {
  document.addEventListener(type, onActivity, true);
}

// React and friends rewrite the focused input's value attribute on every
// keystroke; that is typing, not a page change. Carat's own ring is not either.
new MutationObserver((records) => {
  if (pageChanged) return;
  const focused = deepActiveElement();
  const ours = [ring.element, ghost.element].filter((el): el is HTMLElement => !!el);
  const isOurs = (r: MutationRecord) => ours.some((el) => r.target === el || [...r.addedNodes].includes(el));
  if (records.some((r) => r.target !== focused && !isOurs(r))) {
    pageChanged = true;
  }
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
});

// A fresh page in the middle of a flow (you just clicked "Checkout") gets a
// prediction without waiting for you to touch it. The worker ignores this
// unless you interacted in this tab (or its opener) within the last minute.
schedule("load");

// ---------------------------------------------------------------------------
// Reading memory: when the user leaves the page (switches tab, navigates away),
// send what was on screen. The worker decides whether to use it (the feature
// is opt-in) and distills it into a few notes.

/** Only pages looked at for at least this long count as read. */
const MIN_DWELL_MS = 3000;
const MAX_SEEN_CHARS = 6000;
let visibleSince = document.visibilityState === "visible" ? Date.now() : 0;

/** Text currently in the viewport, in document order, one line per element. */
function visibleText(): string {
  const lines: string[] = [];
  let size = 0;
  let lastParent: Element | null = null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || p.closest("script, style, noscript, template, textarea, [aria-hidden=true]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const range = document.createRange();
  for (let n = walker.nextNode(); n && size < MAX_SEEN_CHARS; n = walker.nextNode()) {
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const text = n.nodeValue!.replace(/\s+/g, " ").trim();
    const parent = n.parentElement;
    if (parent === lastParent && lines.length) lines[lines.length - 1] += " " + text;
    else lines.push(text);
    lastParent = parent;
    size += text.length + 1;
  }
  return maskSensitive(lines.join("\n")).slice(0, MAX_SEEN_CHARS);
}

function sendSeen(): void {
  if (!visibleSince || Date.now() - visibleSince < MIN_DWELL_MS) return;
  visibleSince = 0;
  // A page asking for a password is not one to remember.
  if (document.querySelector("input[type=password]")) return;
  const text = visibleText();
  if (text.length >= 40) post({ type: "seen", url: location.href, title: document.title, text });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") sendSeen();
  else visibleSince = Date.now();
});
