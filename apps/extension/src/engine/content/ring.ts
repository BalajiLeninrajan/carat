/**
 * The ring around a predicted target, and the chip saying what right Shift will do.
 *
 * Drawn in a closed shadow root on a fixed, full-viewport host with
 * pointer-events: none, so it can never intercept a click (or the hit test
 * the worker does before clicking). The host is aria-hidden so the chip text
 * never ends up in the accessibility tree the next prompt is built from.
 */

import type { ActionKind } from "../shared/protocol";

/**
 * The one description of the ring: its colour, width, radius and how far
 * outside the control it sits. The chip is drawn against the same record, so
 * there is a single accent in the extension and the ring, the control and the
 * pill read as one mark rather than three.
 *
 * The geometry is the prototype's. The colours are carat's own, which is why
 * the rgb triples are here too: CSS cannot take a hex colour apart, and the
 * marks on a control need the accent at several opacities.
 */
export const RING = {
  // Mauve, the design system's accent, so the ring reads as part of carat
  // rather than a browser focus ring. These are the dark-page values (Mocha);
  // a light page gets the same hues from Latte, which hold up on white.
  accent: "#cba6f7",
  accentRgb: "203, 166, 247",
  armed: "#f9e2af",
  armedRgb: "249, 226, 175",
  onLight: {
    accent: "#8839ef",
    accentRgb: "136, 57, 239",
    armed: "#df8e1d",
    armedRgb: "223, 142, 29",
  },
  widthPx: 3,
  radiusPx: 7,
  padPx: 3,
} as const;

export type Tone = "dark" | "light";

const RGB = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)/;

/** The relative brightness of a CSS colour, 0 to 1, or null when it is transparent or unreadable. */
function brightness(color: string): number | null {
  const m = RGB.exec(color);
  if (!m) return null;
  if (m[4] !== undefined) {
    const a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a < 0.5) return null;
  }
  const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Whether the page behind a control is dark or light: the first ancestor
 * that paints a background decides. A page that paints nothing is white,
 * unless it has asked for a dark colour scheme.
 */
export function toneBehind(el: Element): Tone {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (!view) return "light";
  for (let node: Element | null = el; node; node = node.parentElement) {
    let bg = "";
    try {
      bg = view.getComputedStyle(node).backgroundColor;
    } catch {
      break;
    }
    const y = brightness(bg);
    if (y !== null) return y < 0.5 ? "dark" : "light";
  }
  for (const node of [doc.body, doc.documentElement]) {
    if (!node) continue;
    let scheme = "";
    try {
      scheme = view.getComputedStyle(node).colorScheme ?? "";
    } catch {
      break;
    }
    if (scheme.includes("dark") && !scheme.includes("light")) return "dark";
  }
  return "light";
}

const CSS = `
  :host { all: initial; }
  .ring {
    position: fixed; box-sizing: border-box; border-radius: ${RING.radiusPx}px; pointer-events: none;
    border: ${RING.widthPx}px solid ${RING.accent}; box-shadow: 0 0 0 4px rgba(${RING.accentRgb}, .18);
  }
  .ring.on-light { border-color: ${RING.onLight.accent}; box-shadow: 0 0 0 4px rgba(${RING.onLight.accentRgb}, .16); }
  .ring.pending { border-style: dashed; opacity: .55; box-shadow: none; }
  .ring.armed { border-color: ${RING.armed}; box-shadow: 0 0 0 4px rgba(${RING.armedRgb}, .25); }
  .ring.on-light.armed { border-color: ${RING.onLight.armed}; box-shadow: 0 0 0 4px rgba(${RING.onLight.armedRgb}, .22); }
  .chip {
    position: fixed; display: flex; align-items: center; gap: 6px; white-space: nowrap;
    font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #cdd6f4;
    background: #1e1e2e; padding: 5px 8px 5px 5px; border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, .25); pointer-events: none; max-width: 320px;
  }
  .chip.armed { background: ${RING.armed}; color: #1e1e2e; }
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
  /** Dark or light, read off the page behind the target when the ring goes on. */
  private tone: Tone = "dark";
  private message: string | null = null;
  /** The action has landed, even though another surface is the one saying what it is. */
  private settled = false;

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
    this.tone = toneBehind(target);
    this.action = null;
    this.armed = false;
    this.settled = false;
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

  /**
   * The ring stops looking provisional without taking an action of its own:
   * the chip is up and saying what the action is, so the ring only rings.
   */
  solid(): void {
    this.settled = true;
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
    this.settled = false;
    if (!this.host) return;
    this.ring.hidden = true;
    this.chip.hidden = true;
  }

  /** Which palette the ring is drawn in; the shadow root is closed, so tests read it here. */
  get toneShown(): Tone {
    return this.tone;
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
    this.ring.className =
      "ring" + (this.tone === "light" ? " on-light" : "") + (this.action || this.settled ? "" : " pending") + (this.armed ? " armed" : "");
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
    const pad = RING.padPx;
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
    // Centred on the control, like the chip, so ring, control and hint line up.
    let left = Math.max(4, Math.min(r.left + r.width / 2 - chipW / 2, innerWidth - chipW - 4));
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
