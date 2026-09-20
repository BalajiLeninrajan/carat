/**
 * The ring around a predicted target, and the chip saying what right Shift will do.
 *
 * Drawn in a closed shadow root on a fixed, full-viewport host with
 * pointer-events: none, so it can never intercept a click (or the hit test
 * the worker does before clicking). The host is aria-hidden so the chip text
 * never ends up in the accessibility tree the next prompt is built from.
 */

import type { ActionKind } from "../shared/protocol.js";

const CSS = `
  :host { all: initial; }
  .ring {
    position: fixed; box-sizing: border-box; border-radius: 7px; pointer-events: none;
    border: 2px solid #7c3aed; box-shadow: 0 0 0 4px rgba(124, 58, 237, .18);
    transition: opacity .12s, border-color .12s, box-shadow .12s;
  }
  .ring.pending { border-style: dashed; opacity: .55; box-shadow: none; }
  .ring.armed { border-color: #d97706; box-shadow: 0 0 0 4px rgba(217, 119, 6, .25); }
  .chip {
    position: fixed; display: flex; align-items: center; gap: 6px; white-space: nowrap;
    font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
    background: #7c3aed; padding: 5px 8px 5px 5px; border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, .25); pointer-events: none; max-width: 320px;
    transition: background .12s;
  }
  .chip.armed { background: #d97706; }
  .chip.error { background: #b91c1c; }
  .chip span.label { overflow: hidden; text-overflow: ellipsis; }
  kbd {
    font: 600 10px/1 ui-monospace, Menlo, Consolas, monospace; color: #fff;
    background: rgba(255, 255, 255, .22); border-radius: 4px; padding: 3px 5px;
  }
  [hidden] { display: none !important; }
`;

export interface RingAction {
  kind: ActionKind;
  label: string;
  value: string;
  irreversible: boolean;
}

export class Ring {
  private host: HTMLElement | null = null;
  private ring!: HTMLDivElement;
  private chip!: HTMLDivElement;
  private target: Element | null = null;
  /** Browser actions (tab switch, address bar) have no element: the chip floats. */
  private floating = false;
  private frame = 0;
  private action: RingAction | null = null;
  private armed = false;
  private message: string | null = null;

  /** The host element, so the page MutationObserver can ignore it. */
  get element(): HTMLElement | null {
    return this.host;
  }

  private mount(): void {
    if (this.host?.isConnected) return;
    this.host = document.createElement("carat-ring");
    this.host.setAttribute("aria-hidden", "true");
    this.host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const root = this.host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style><div class="ring" hidden></div><div class="chip" hidden></div>`;
    this.ring = root.querySelector(".ring")!;
    this.chip = root.querySelector(".chip")!;
    document.documentElement.appendChild(this.host);
  }

  /** Ring the element while the rest of the prediction streams in. */
  /** Show only a chip, for an action that is about the browser, not the page. */
  showFloating(action: RingAction): void {
    this.mount();
    this.target = null;
    this.floating = true;
    this.armed = false;
    this.message = null;
    this.action = action;
    this.ring.hidden = true;
    this.render();
    this.position();
  }

  show(target: Element): void {
    this.mount();
    this.floating = false;
    this.target = target;
    this.action = null;
    this.armed = false;
    this.message = null;
    this.render();
    this.ring.hidden = false;
    cancelAnimationFrame(this.frame);
    const loop = () => {
      this.position();
      this.frame = requestAnimationFrame(loop);
    };
    loop();
  }

  setAction(action: RingAction): void {
    this.action = action;
    this.render();
  }

  setArmed(armed: boolean): void {
    this.armed = armed;
    this.render();
  }

  /** Show a message on the chip (e.g. why an accept was refused). */
  flash(message: string): void {
    this.message = message;
    this.render();
  }

  hide(): void {
    cancelAnimationFrame(this.frame);
    this.target = null;
    this.floating = false;
    this.action = null;
    if (!this.host) return;
    this.ring.hidden = true;
    this.chip.hidden = true;
  }

  get visible(): boolean {
    return this.target != null || this.floating;
  }

  /** Is the target outside the viewport? */
  offscreen(): boolean {
    if (!this.target) return false; // floating chips are always in view
    const r = this.target.getBoundingClientRect();
    return r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
  }

  private render(): void {
    if (!this.host) return;
    this.ring.className = "ring" + (this.action ? "" : " pending") + (this.armed ? " armed" : "");
    this.chip.className = "chip" + (this.armed ? " armed" : "") + (this.message ? " error" : "");
    const a = this.action;
    if (!a && !this.message) {
      this.chip.hidden = true;
      return;
    }
    this.chip.hidden = false;
    this.chip.replaceChildren();
    const add = (tag: string, text: string, cls?: string) => {
      const el = document.createElement(tag);
      el.textContent = text;
      if (cls) el.className = cls;
      this.chip.appendChild(el);
    };
    if (this.message) {
      add("span", this.message, "label");
      return;
    }
    add("kbd", "R⇧");
    if (a!.irreversible && !this.armed) add("kbd", "R⇧");
    const value = a!.value && !a!.label.includes(a!.value) ? `: ${a!.value}` : "";
    const verb = a!.kind === "switch" ? "Switch to " : a!.kind === "open" ? "Open " : "";
    const text = a!.kind === "fill" || a!.kind === "select" ? a!.label + value : verb + a!.label;
    add("span", this.armed ? `again to ${a!.label}` : text, "label");
  }

  private position(): void {
    if (this.floating && this.host) {
      // Bottom centre: it is about the browser, not a spot on the page.
      const chipW = this.chip.offsetWidth || 160;
      this.chip.style.left = `${Math.max(4, (innerWidth - chipW) / 2)}px`;
      this.chip.style.top = `${innerHeight - (this.chip.offsetHeight || 24) - 24}px`;
      return;
    }
    const t = this.target;
    if (!t || !this.host) return;
    if (!t.isConnected) {
      this.hide();
      return;
    }
    const r = t.getBoundingClientRect();
    const pad = 3;
    Object.assign(this.ring.style, {
      left: `${r.left - pad}px`,
      top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });
    if (this.chip.hidden) return;

    // Chip above the ring, or below it near the top edge; pinned to the edge
    // (with an arrow) when the target is scrolled out of view.
    const chipH = this.chip.offsetHeight || 22;
    const chipW = this.chip.offsetWidth || 120;
    let top = r.top - pad - chipH - 6;
    if (top < 4) top = r.bottom + pad + 6;
    let left = Math.min(Math.max(4, r.left - pad), innerWidth - chipW - 4);
    let arrow = "";
    if (r.bottom < 0) {
      top = 8;
      arrow = "↑ ";
    } else if (r.top > innerHeight) {
      top = innerHeight - chipH - 8;
      arrow = "↓ ";
    }
    if (arrow) left = Math.max(4, (innerWidth - chipW) / 2);
    this.chip.style.left = `${left}px`;
    this.chip.style.top = `${top}px`;
    this.chip.dataset.arrow = arrow;
  }
}
