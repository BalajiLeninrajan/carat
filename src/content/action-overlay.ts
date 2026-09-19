/**
 * Draws a predicted action: a ring around the control and a chip that says
 * what Tab will do. It is the action equivalent of ghost text - visible enough
 * to notice, quiet enough to ignore.
 *
 * An irreversible action shows as two Tabs; after the first it turns amber and
 * the chip reads "again", so a stray Tab can never send, pay or delete.
 */

export interface ActionView {
  label: string;
  irreversible: boolean;
  armed: boolean;
  /** Text a focus action will offer once the field is focused. */
  preview?: string;
}

const RING_PAD = 3;
const CHIP_GAP = 6;

export class ActionOverlay {
  private host: HTMLDivElement | null = null;
  private ring!: HTMLDivElement;
  private chip!: HTMLDivElement;
  private labelEl: HTMLSpanElement | null = null;
  private target: Element | null = null;
  private view: ActionView | null = null;
  private frame = 0;
  private resizeObserver: ResizeObserver | null = null;

  private readonly onViewportChange = () => this.schedule();

  get element(): Element | null {
    return this.target;
  }

  private ensure(): void {
    if (this.host) return;
    const host = document.createElement("div");
    host.setAttribute("data-carat", "action");
    // Out of the accessibility tree, or the next prediction reads its own chip.
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all: initial; position: static;";
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host { --accent: #4f8cff; --amber: #f5a524; }
      .ring {
        position: fixed;
        pointer-events: none;
        box-sizing: border-box;
        border: 2px solid var(--accent);
        border-radius: 8px;
        box-shadow: 0 0 0 4px rgba(79, 140, 255, 0.18);
        z-index: 2147483646;
        animation: pulse 1.8s ease-in-out infinite;
      }
      .ring.armed {
        border-color: var(--amber);
        box-shadow: 0 0 0 4px rgba(245, 165, 36, 0.22);
      }
      .chip {
        position: fixed;
        pointer-events: none;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        max-width: 320px;
        padding: 3px 9px 3px 4px;
        border-radius: 999px;
        background: #10131a;
        color: #e6ecf5;
        font: 500 12px/18px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
        white-space: nowrap;
      }
      .chip .label { overflow: hidden; text-overflow: ellipsis; }
      .chip .preview { color: #8fa3bf; overflow: hidden; text-overflow: ellipsis; }
      .chip kbd {
        font: 600 10px/16px ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 0 5px;
        border-radius: 5px;
        background: var(--accent);
        color: #fff;
      }
      .chip.armed kbd { background: var(--amber); color: #1a1204; }
      .chip .warn { color: var(--amber); }
      @keyframes pulse {
        0%, 100% { box-shadow: 0 0 0 4px rgba(79, 140, 255, 0.18); }
        50% { box-shadow: 0 0 0 7px rgba(79, 140, 255, 0.06); }
      }
      @media (prefers-reduced-motion: reduce) { .ring { animation: none; } }
    `;

    this.ring = document.createElement("div");
    this.ring.className = "ring";
    this.chip = document.createElement("div");
    this.chip.className = "chip";
    shadow.append(style, this.ring, this.chip);

    document.documentElement.append(host);
    this.host = host;

    addEventListener("scroll", this.onViewportChange, { capture: true, passive: true });
    addEventListener("resize", this.onViewportChange, { passive: true });
  }

  show(target: Element, view: ActionView): void {
    this.ensure();
    if (this.target !== target) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(target);
      this.target = target;
    }
    this.view = view;
    this.renderChip();
    this.position();
  }

  clear(): void {
    this.view = null;
    this.target = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.host) {
      this.ring.style.display = "none";
      this.chip.style.display = "none";
    }
  }

  private renderChip(): void {
    const view = this.view;
    if (!view) return;
    this.chip.replaceChildren();
    this.chip.classList.toggle("armed", view.armed);
    this.ring.classList.toggle("armed", view.armed);

    const key = document.createElement("kbd");
    key.textContent = view.irreversible && !view.armed ? "Tab Tab" : "Tab";
    this.chip.append(key);

    if (view.armed) {
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = "again to";
      this.chip.append(warn);
    }

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = view.label;
    this.chip.append(label);
    this.labelEl = label;

    if (view.preview) {
      const preview = document.createElement("span");
      preview.className = "preview";
      preview.textContent = `“${view.preview}”`;
      this.chip.append(preview);
    }
  }

  private schedule(): void {
    if (!this.view || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.position();
    });
  }

  private position(): void {
    const target = this.target;
    if (!target || !this.view || !this.host) return;

    if (!target.isConnected) {
      this.clear();
      return;
    }

    const rect = target.getBoundingClientRect();
    const ring = this.ring.style;
    const chip = this.chip.style;
    chip.display = "flex";

    const offscreenAbove = rect.bottom < 0;
    const offscreenBelow = rect.top > innerHeight;
    const offscreen = offscreenAbove || offscreenBelow || rect.width === 0;

    // The arrow says which way to look; it has to go again once it is on screen.
    if (this.labelEl) {
      const arrow = offscreen ? (offscreenAbove ? " ↑" : " ↓") : "";
      const wanted = this.view.label + arrow;
      if (this.labelEl.textContent !== wanted) this.labelEl.textContent = wanted;
    }

    if (offscreen) {
      // Dock the chip to the viewport edge the target is past; Tab scrolls to it.
      ring.display = "none";
      const width = this.chip.offsetWidth;
      chip.left = `${Math.max(8, (innerWidth - width) / 2)}px`;
      chip.top = offscreenAbove ? `${CHIP_GAP + 4}px` : `${innerHeight - 30 - CHIP_GAP}px`;
      return;
    }

    ring.display = "block";
    ring.left = `${rect.left - RING_PAD}px`;
    ring.top = `${rect.top - RING_PAD}px`;
    ring.width = `${rect.width + RING_PAD * 2}px`;
    ring.height = `${rect.height + RING_PAD * 2}px`;

    const chipHeight = this.chip.offsetHeight || 24;
    const chipWidth = this.chip.offsetWidth || 120;
    // Above the control unless that would leave the viewport; then below.
    const above = rect.top - RING_PAD - CHIP_GAP - chipHeight;
    const top = above >= 4 ? above : rect.bottom + RING_PAD + CHIP_GAP;
    const left = Math.min(Math.max(4, rect.left - RING_PAD), innerWidth - chipWidth - 4);
    chip.left = `${left}px`;
    chip.top = `${top}px`;
  }
}
