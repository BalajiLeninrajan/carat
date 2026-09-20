/**
 * Carrying out an accepted action through the debugger.
 *
 * Ported from the prototype's `src/background/actuate.ts` on origin/testing.
 * The bodies are theirs; what changed is that every entry point takes the
 * tab's CDP sender rather than a tab id, so the content script's own perform
 * path and a test can both drive it, and `fill` was added for the fields the
 * page cannot reach itself.
 *
 * Every action goes to the exact DOM node behind the accessibility node the
 * model picked (its backendDOMNodeId): no screen coordinates, no hit testing,
 * so it cannot land on the wrong element even if the target is scrolled away
 * or something is drawn on top of it.
 */

import type { CdpSend } from '../outline/cdp';

export type ActuateResult = { ok: true } | { ok: false; reason: string };

/**
 * The event the worker dispatches on the node a prediction targets, so the
 * content script can take the element from `event.target` and perform on it
 * with the page's own fill and click paths. The detail carries the token of
 * the request that asked, so a stale announcement is never acted on.
 */
export const TARGET_EVENT = 'carat-cdp-target';

async function objectFor(send: CdpSend, backendNodeId: number): Promise<string> {
  const { object } = await send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId });
  return object.objectId;
}

async function callOn<T>(send: CdpSend, objectId: string, fn: string, args: unknown[] = [], userGesture = false): Promise<T> {
  const { result, exceptionDetails } = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((a) => ({ value: a })),
    returnByValue: true,
    userGesture,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
}

function release(send: CdpSend, ...objectIds: string[]): void {
  for (const objectId of objectIds) void Promise.resolve(send('Runtime.releaseObject', { objectId })).catch(() => undefined);
}

/** Hand the element to the content script: its capture listener reads `event.target`. */
export async function announceTarget(send: CdpSend, backendNodeId: number, token: string): Promise<void> {
  const objectId = await objectFor(send, backendNodeId);
  try {
    await callOn(
      send,
      objectId,
      `function (type, token) { this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail: token })); }`,
      [TARGET_EVENT, token],
    );
  } finally {
    release(send, objectId);
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

export async function click(send: CdpSend, backendNodeId: number): Promise<ActuateResult> {
  const objectId = await objectFor(send, backendNodeId);
  try {
    // userGesture: counts as user activation, so a link that opens a new tab is not popup-blocked.
    const outcome = await callOn<string>(send, objectId, ACTIVATE, [], true);
    return outcome === 'ok' ? { ok: true } : { ok: false, reason: 'The target is no longer on the page.' };
  } finally {
    release(send, objectId);
  }
}

export async function focus(send: CdpSend, backendNodeId: number): Promise<ActuateResult> {
  await send('DOM.getDocument', { depth: 0 });
  await Promise.resolve(send('DOM.scrollIntoViewIfNeeded', { backendNodeId })).catch(() => undefined);
  await send('DOM.focus', { backendNodeId });
  return { ok: true };
}

/**
 * Pick an option in a native `<select>` through the native value setter, so
 * frameworks that track the value (React) see the change. Custom ARIA
 * comboboxes are not selects; for those the caller falls back to a click.
 */
export async function select(send: CdpSend, backendNodeId: number, optionText: string): Promise<ActuateResult | null> {
  const objectId = await objectFor(send, backendNodeId);
  try {
    const outcome = await callOn<'not-select' | 'no-option' | 'ok'>(
      send,
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
    if (outcome === 'not-select') return null;
    if (outcome === 'no-option') return { ok: false, reason: `No option "${optionText}".` };
    return { ok: true };
  } catch {
    return null;
  } finally {
    release(send, objectId);
  }
}

/**
 * Carat's addition. A field the content script could not reach — one in a
 * cross-origin frame, or one the page would not hand over — is filled here,
 * through the same native value setter the page's own fill path uses, so
 * React's value tracker sees a real change and the page gets `input` and
 * `change` as a keystroke would fire them.
 */
export async function fill(send: CdpSend, backendNodeId: number, value: string): Promise<ActuateResult> {
  const objectId = await objectFor(send, backendNodeId);
  try {
    const outcome = await callOn<'gone' | 'not-a-field' | 'ok'>(
      send,
      objectId,
      `function (text) {
        const el = this;
        if (!el.isConnected) return "gone";
        if (typeof el.focus === "function") el.focus({ preventScroll: true });
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, text);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return "ok";
        }
        if (el.isContentEditable) {
          el.textContent = text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          return "ok";
        }
        return "not-a-field";
      }`,
      [value],
    );
    if (outcome === 'gone') return { ok: false, reason: 'The target is no longer on the page.' };
    if (outcome === 'not-a-field') return { ok: false, reason: 'Nothing on that control takes text.' };
    return { ok: true };
  } finally {
    release(send, objectId);
  }
}
