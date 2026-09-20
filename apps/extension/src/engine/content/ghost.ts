/**
 * Ghost text for <input> and <textarea>.
 *
 * You cannot put nodes inside a text field, so this draws a mirror: a box laid
 * exactly over the field, with the field's font, padding, border widths,
 * alignment and wrapping copied over. It holds the field's current text in a
 * transparent span (so glyph advance matches to the pixel) followed by the
 * suggestion in a dimmed span, and then the Tab keycap that takes it. The
 * mirror scrolls with the field and never takes pointer events. Its host is
 * aria-hidden so the suggestion never shows up in the accessibility tree
 * Carat reads.
 *
 * None of this is in the field: the value, the caret and every measurement
 * taken off them are the page's own and are never touched.
 */

import { KEYCAP_CSS } from "../../chip/styles";

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Properties that decide where glyphs land. */
const COPIED = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant",
  "fontFeatureSettings", "fontKerning", "letterSpacing", "wordSpacing", "textTransform",
  "textIndent", "textAlign", "direction", "lineHeight", "tabSize", "wordBreak", "overflowWrap",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing",
] as const;

export class Ghost {
  private host: HTMLElement | null = null;
  private box!: HTMLDivElement;
  private inner!: HTMLDivElement;
  private typedSpan!: HTMLSpanElement;
  private ghostSpan!: HTMLSpanElement;
  /** The suggestion's last word and the keycap, kept on one line together. */
  private tailSpan!: HTMLSpanElement;
  private wordSpan!: HTMLSpanElement;
  private hint!: HTMLElement;
  private field: TextField | null = null;
  private frame = 0;

  get element(): HTMLElement | null {
    return this.host;
  }

  /**
   * What the mirror is drawing, for tests: the shadow root is closed, so
   * there is no other way to see it. `line` is every glyph in order, which is
   * what says the keycap comes after the last one of the suggestion.
   */
  get drawn(): { ghost: string; hint: string | null; tail: string; line: string } | null {
    if (!this.host || this.host.style.display === "none") return null;
    return {
      ghost: (this.ghostSpan.textContent ?? "") + (this.wordSpan.textContent ?? ""),
      hint: this.hint.hidden ? null : this.hint.textContent,
      tail: this.tailSpan.textContent ?? "",
      line: this.inner.textContent ?? "",
    };
  }

  private mount(): void {
    if (this.host?.isConnected) return;
    this.host = document.createElement("carat-ghost");
    this.host.setAttribute("aria-hidden", "true");
    this.host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    const root = this.host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host { all: initial; }
      .box { position: fixed; overflow: hidden; pointer-events: none; border-style: solid; border-color: transparent; background: transparent; margin: 0; }
      .box.single { display: flex; align-items: center; }
      .inner { min-width: 100%; }
      .single .inner { white-space: pre; }
      .multi .inner { white-space: pre-wrap; }
      .typed { color: transparent; }
      .ghost, .tail { opacity: .45; }
      /* The last word and the key travel together, so the key is never left
         sitting on a line of its own. */
      .tail { white-space: nowrap; }
      kbd.hint {
        all: initial;${KEYCAP_CSS}
        margin-left: 4px;
        vertical-align: baseline;
      }
      kbd.hint[hidden] { display: none; }
    </style><div class="box"><div class="inner"><span class="typed"></span><span class="ghost"></span><span class="tail"><span class="word"></span><kbd class="hint">Tab</kbd></span></div></div>`;
    this.box = root.querySelector(".box")!;
    this.inner = root.querySelector(".inner")!;
    this.typedSpan = root.querySelector(".typed")!;
    this.ghostSpan = root.querySelector(".ghost")!;
    this.tailSpan = root.querySelector(".tail")!;
    this.wordSpan = root.querySelector(".word")!;
    this.hint = root.querySelector("kbd.hint")!;
    document.documentElement.appendChild(this.host);
  }

  show(field: TextField, suggestion: string): void {
    this.mount();
    const multiline = field instanceof HTMLTextAreaElement;
    if (!multiline) suggestion = suggestion.replace(/[\r\n]+/g, " ");
    if (this.field !== field) {
      this.field = field;
      const cs = getComputedStyle(field);
      for (const p of COPIED) (this.box.style as any)[p] = cs[p];
      this.box.className = "box " + (multiline ? "multi" : "single");
      this.ghostSpan.style.color = cs.color;
      this.tailSpan.style.color = cs.color;
    }
    this.typedSpan.textContent = field.value;
    // The key that takes the suggestion goes after its last glyph, sharing a
    // no-wrap span with the last word so the two wrap as one.
    const lastWord = suggestion.search(/\S+$/);
    this.ghostSpan.textContent = lastWord > 0 ? suggestion.slice(0, lastWord) : lastWord === 0 ? "" : suggestion;
    this.wordSpan.textContent = lastWord >= 0 ? suggestion.slice(lastWord) : "";
    this.hint.hidden = suggestion === "";
    this.host!.style.display = "";
    cancelAnimationFrame(this.frame);
    const loop = () => {
      this.position();
      this.frame = requestAnimationFrame(loop);
    };
    loop();
  }

  hide(): void {
    cancelAnimationFrame(this.frame);
    this.field = null;
    if (this.host) this.host.style.display = "none";
  }

  private position(): void {
    const f = this.field;
    if (!f?.isConnected) return this.hide();
    const r = f.getBoundingClientRect();
    Object.assign(this.box.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    // Follow the field's own scrolling.
    this.inner.style.transform = `translate(${-f.scrollLeft}px, ${-f.scrollTop}px)`;
  }
}
