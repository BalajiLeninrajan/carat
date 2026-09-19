export type EditableField = HTMLInputElement | HTMLTextAreaElement;

/**
 * You cannot put a child node inside an <input>, so the ghost text is drawn by
 * a mirror: an overlay that re-renders the field's own text in transparent ink,
 * then the suggestion in dim ink right after it. Copying the field's text
 * metrics is what makes the two line up to the pixel.
 */

const COPIED_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "textAlign",
  "direction",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "tabSize",
] as const;

export class GhostRenderer {
  private host: HTMLDivElement | null = null;
  private mirror!: HTMLDivElement;
  private inner!: HTMLSpanElement;
  private typedSpan!: HTMLSpanElement;
  private ghostSpan!: HTMLSpanElement;

  private field: EditableField | null = null;
  private suggestion = "";
  private frame = 0;
  private resizeObserver: ResizeObserver | null = null;

  private readonly onViewportChange = () => this.schedulePosition();

  private ensureHost(): void {
    if (this.host) return;

    const host = document.createElement("div");
    host.setAttribute("data-carat", "ghost");
    // Keep our own suggestion out of the accessibility tree, or the next
    // request reads it back as page content and completes its own output.
    host.setAttribute("aria-hidden", "true");
    // Keep the overlay out of the page's layout and out of its stylesheets.
    host.style.cssText = "all: initial; position: static;";
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      .mirror {
        position: fixed;
        margin: 0;
        pointer-events: none;
        overflow: hidden;
        background: transparent;
        border-style: solid;
        border-color: transparent;
        box-sizing: border-box;
        z-index: 2147483646;
        contain: strict;
      }
      .inner { display: block; will-change: transform; }
      .typed { color: transparent; }
      .ghost { opacity: 0.45; }
    `;

    this.mirror = document.createElement("div");
    this.mirror.className = "mirror";
    this.inner = document.createElement("span");
    this.inner.className = "inner";
    this.typedSpan = document.createElement("span");
    this.typedSpan.className = "typed";
    this.ghostSpan = document.createElement("span");
    this.ghostSpan.className = "ghost";

    this.inner.append(this.typedSpan, this.ghostSpan);
    this.mirror.append(this.inner);
    shadow.append(style, this.mirror);

    // documentElement, not body: a transformed <body> would re-anchor position:fixed.
    document.documentElement.append(host);
    this.host = host;

    addEventListener("scroll", this.onViewportChange, { capture: true, passive: true });
    addEventListener("resize", this.onViewportChange, { passive: true });
  }

  show(field: EditableField, suggestion: string): void {
    if (!suggestion) {
      this.clear();
      return;
    }
    this.ensureHost();

    if (this.field !== field) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => this.schedulePosition());
      this.resizeObserver.observe(field);
      this.field = field;
    }

    const isInput = field instanceof HTMLInputElement;
    this.suggestion = isInput ? suggestion.replace(/[\r\n]+/g, " ") : suggestion;
    this.position();
  }

  clear(): void {
    this.suggestion = "";
    if (this.mirror) this.mirror.style.display = "none";
  }

  destroy(): void {
    this.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    removeEventListener("scroll", this.onViewportChange, { capture: true });
    removeEventListener("resize", this.onViewportChange);
    this.host?.remove();
    this.host = null;
    this.field = null;
  }

  private schedulePosition(): void {
    if (!this.suggestion || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.position();
    });
  }

  private position(): void {
    const field = this.field;
    if (!field || !this.suggestion || !this.host) return;

    const rect = field.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      this.mirror.style.display = "none";
      return;
    }

    const computed = getComputedStyle(field);
    if (computed.visibility === "hidden" || computed.display === "none") {
      this.mirror.style.display = "none";
      return;
    }

    const mirror = this.mirror.style;
    mirror.display = "block";
    mirror.left = `${rect.left}px`;
    mirror.top = `${rect.top}px`;
    mirror.width = `${rect.width}px`;
    mirror.height = `${rect.height}px`;

    for (const prop of COPIED_STYLES) {
      mirror.setProperty(
        prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
        computed[prop],
      );
    }

    const multiline = field instanceof HTMLTextAreaElement;
    mirror.whiteSpace = multiline ? "pre-wrap" : "pre";
    mirror.overflowWrap = multiline ? "break-word" : "normal";
    this.ghostSpan.style.color = computed.color;

    // Keep the ghost glued to the text when the field itself is scrolled.
    const dx = multiline ? 0 : -field.scrollLeft;
    const dy = multiline ? -field.scrollTop : 0;
    this.inner.style.transform = `translate(${dx}px, ${dy}px)`;

    this.typedSpan.textContent = field.value;
    this.ghostSpan.textContent = this.suggestion;
  }
}
