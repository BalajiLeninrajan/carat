/**
 * Carrying out an accepted action through CDP.
 *
 * Every action goes to the exact DOM node behind the accessibility node the
 * model picked (its backendDOMNodeId): no screen coordinates, no hit testing,
 * so it cannot land on the wrong element, even if the target is scrolled away
 * or something is drawn on top of it.
 */

import { send } from "./cdp.js";
import { TARGET_EVENT } from "../shared/protocol.js";

export type ActuateResult = { ok: true } | { ok: false; reason: string };

async function objectFor(tabId: number, backendNodeId: number): Promise<string> {
  const { object } = await send<{ object: { objectId: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
  return object.objectId;
}

async function callOn<T>(tabId: number, objectId: string, fn: string, args: unknown[] = [], userGesture = false): Promise<T> {
  const { result, exceptionDetails } = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((a) => (typeof a === "object" && a && "objectId" in a ? a : { value: a })),
      returnByValue: true,
      userGesture,
    },
  );
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
}

function release(tabId: number, ...objectIds: string[]): void {
  for (const objectId of objectIds) send(tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
}

/** Hand the element to the content script (its capture listener reads event.target). */
export async function announceTarget(tabId: number, backendNodeId: number): Promise<void> {
  const objectId = await objectFor(tabId, backendNodeId);
  try {
    await callOn(tabId, objectId, `function (type) { this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true })); }`, [TARGET_EVENT]);
  } finally {
    release(tabId, objectId);
  }
}

/**
 * Runs in the page with `this` = the target: the same event sequence a real
 * mouse click produces, fired on the element itself, then el.click() for the
 * default activation (following a link, toggling a checkbox, submitting a form).
 */
export const ACTIVATE = `function () {
  const el = this;
  if (!el.isConnected) return "gone";
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const base = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
  };
  const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerover", pointer));
  el.dispatchEvent(new MouseEvent("mouseover", base));
  el.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
  el.click();
  return "ok";
}`;

export async function click(tabId: number, backendNodeId: number): Promise<ActuateResult> {
  const objectId = await objectFor(tabId, backendNodeId);
  try {
    // userGesture: counts as user activation, so e.g. links that open a new tab are not popup-blocked.
    const outcome = await callOn<string>(tabId, objectId, ACTIVATE, [], true);
    return outcome === "ok" ? { ok: true } : { ok: false, reason: "The target is no longer on the page." };
  } finally {
    release(tabId, objectId);
  }
}

/**
 * Put a value into a field the way typing would: through the native setter, so
 * frameworks that track .value (React) see it, then input and change events.
 * Handles text inputs, textareas, date/time inputs and contenteditable.
 */
export async function setValue(tabId: number, backendNodeId: number, value: string): Promise<ActuateResult> {
  const objectId = await objectFor(tabId, backendNodeId);
  try {
    const outcome = await callOn<string>(
      tabId,
      objectId,
      `function (value) {
        const el = this;
        if (!el.isConnected) return "gone";
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        if (typeof el.focus === "function") el.focus({ preventScroll: true });
        if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          return "ok";
        }
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (!desc || !desc.set) return "not-a-field";
        desc.set.call(el, value);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok";
      }`,
      [value],
      true,
    );
    if (outcome === "ok") return { ok: true };
    return { ok: false, reason: outcome === "gone" ? "The field is no longer on the page." : "That target is not a field." };
  } finally {
    release(tabId, objectId);
  }
}

/**
 * Press Enter in a field. Search boxes and many forms submit this way, and
 * their "Search" button often does nothing when clicked. The key events go
 * through CDP, so they are trusted.
 */
export async function pressEnter(tabId: number, backendNodeId: number): Promise<ActuateResult> {
  const focused = await focus(tabId, backendNodeId);
  if (!focused.ok) return focused;
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
  await send(tabId, "Input.dispatchKeyEvent", { type: "char", ...key, text: "\r" });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
  return { ok: true };
}

export async function focus(tabId: number, backendNodeId: number): Promise<ActuateResult> {
  await send(tabId, "DOM.getDocument", { depth: 0 });
  await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  await send(tabId, "DOM.focus", { backendNodeId });
  return { ok: true };
}

/**
 * Pick an option in a native <select> through the native value setter, so
 * frameworks that track the value (React) see the change. Custom ARIA
 * comboboxes are not <select>s; for those the caller falls back to a click.
 */
export async function select(tabId: number, backendNodeId: number, optionText: string): Promise<ActuateResult | null> {
  const objectId = await objectFor(tabId, backendNodeId);
  try {
    const outcome = await callOn<"not-select" | "no-option" | "ok">(
      tabId,
      objectId,
      `function (text) {
        if (!(this instanceof HTMLSelectElement)) return "not-select";
        const want = text.trim().toLowerCase();
        const opts = [...this.options];
        const opt = opts.find((o) => o.text.trim().toLowerCase() === want)
          || opts.find((o) => o.text.trim().toLowerCase().includes(want));
        if (!opt) return "no-option";
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(this, opt.value);
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok";
      }`,
      [optionText],
    );
    if (outcome === "not-select") return null;
    if (outcome === "no-option") return { ok: false, reason: `No option "${optionText}".` };
    return { ok: true };
  } finally {
    release(tabId, objectId);
  }
}
