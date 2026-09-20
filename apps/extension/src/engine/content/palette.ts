/**
 * The instruction box (Ctrl+Shift+K) and the panel that shows what the task is
 * doing, both in one closed shadow root.
 *
 * Keys typed in the box are stopped from reaching the page, so a site's own
 * shortcuts (and carat's own suggestion handling) never see them. The one
 * exception is carat's key: a step can be confirmed while the question box has
 * focus. The host is aria-hidden so none of this lands in the accessibility
 * tree carat reads.
 *
 * The prototype drew this in white with its own purple. Here it wears the
 * chip's colours, because it is the same extension talking.
 */

import { ACCEPT_GLYPH, ACCEPT_KEY_NAME } from "../../chip/accept-key";
import { KEYCAP_CSS } from "../../chip/styles";
import { registerSurface } from "../../dom/surfaces";

export type StepState = "running" | "done" | "failed" | "skipped" | "waiting";

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .scrim {
    position: fixed; inset: 0; display: grid; place-items: start center; padding-top: 18vh;
    background: rgba(17, 17, 27, .45);
  }
  .box {
    width: min(620px, 92vw); background: #1e1e2e; color: #cdd6f4; border-radius: 10px;
    box-shadow: 0 24px 60px rgba(17, 17, 27, .55), 0 0 0 1px rgba(205, 214, 244, .08);
    overflow: hidden;
  }
  .row { display: flex; align-items: center; gap: 10px; padding: 14px 16px; }
  .mark {
    font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1e1e2e; background: #cba6f7; padding: 5px 7px; border-radius: 6px;
  }
  input { flex: 1; border: 0; outline: 0; font-size: 16px; color: inherit; background: transparent; }
  input::placeholder { color: #6c7086; }
  .hint { display: flex; align-items: center; gap: 5px; padding: 0 16px 12px; font-size: 12px; color: #a6adc8; }
  .hint kbd { all: initial;${KEYCAP_CSS}}
  .panel {
    position: fixed; right: 16px; bottom: 16px; width: 340px; max-height: 60vh; overflow: auto;
    background: #1e1e2e; color: #cdd6f4; border-radius: 8px;
    box-shadow: 0 10px 30px rgba(17, 17, 27, .45), 0 0 0 1px rgba(205, 214, 244, .08);
    font-size: 12px; line-height: 1.35;
  }
  .panel header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #313244; }
  .goal { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stop {
    border: 1px solid #45475a; background: #313244; color: #cdd6f4; border-radius: 6px;
    padding: 3px 8px; font: inherit; font-size: 11px; cursor: pointer;
  }
  .stop:hover { background: #45475a; }
  ol { margin: 0; padding: 8px 12px 10px 28px; }
  li { margin: 6px 0; color: #cdd6f4; }
  li .why { color: #a6adc8; }
  li[data-state=running] { color: #cba6f7; }
  li[data-state=failed] { color: #f38ba8; }
  li[data-state=skipped] { color: #6c7086; text-decoration: line-through; }
  li[data-state=waiting] { color: #f9e2af; }
  .summary { padding: 8px 12px 12px; color: #a6adc8; border-top: 1px solid #313244; }
  .ask { padding: 10px 12px; border-top: 1px solid #313244; }
  .ask .q { margin-bottom: 6px; }
  .ask input {
    border: 1px solid #45475a; background: #181825; border-radius: 6px;
    padding: 6px 8px; width: 100%; font-size: 12px; color: #cdd6f4;
  }
  [hidden] { display: none !important; }
`;

export class Palette {
  private host: HTMLElement | null = null;
  private scrim!: HTMLDivElement;
  private input!: HTMLInputElement;
  private panel!: HTMLDivElement;
  private goalEl!: HTMLElement;
  private list!: HTMLOListElement;
  private summary!: HTMLDivElement;
  private ask!: HTMLDivElement;
  private askInput!: HTMLInputElement;
  private unregister: (() => void) | null = null;

  /** Called with the instruction the user typed. */
  onSubmit: (goal: string) => void = () => {};
  /** Called when the user answers a question the task asked. */
  onAnswer: (answer: string) => void = () => {};
  /** Called when the user presses Esc in the question box. */
  onQuestionEscape: () => void = () => {};
  onStop: () => void = () => {};

  /** The host element, so the page MutationObserver can ignore it. */
  get element(): HTMLElement | null {
    return this.host;
  }
  get isOpen(): boolean {
    return !!this.host && !this.scrim.hidden;
  }
  get hasTask(): boolean {
    return !!this.host && !this.panel.hidden;
  }
  /** The steps as drawn; the shadow root is closed, so tests read them here. */
  get steps(): { text: string; state: string }[] {
    if (!this.host) return [];
    return [...this.list.children].map((li) => ({
      text: li.textContent ?? "",
      state: (li as HTMLElement).dataset.state ?? "",
    }));
  }
  /** The question on screen, or null. */
  get question(): string | null {
    if (!this.host || this.ask.hidden) return null;
    return this.ask.querySelector(".q")?.textContent ?? null;
  }

  private mount(): void {
    if (this.host?.isConnected) return;
    this.host = document.createElement("carat-palette");
    this.host.setAttribute("aria-hidden", "true");
    this.host.style.cssText = "position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483647;";
    const root = this.host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style>
      <div class="scrim" hidden>
        <div class="box">
          <div class="row"><span class="mark">Carat</span><input type="text" placeholder="What should Carat do on this page?" /></div>
          <div class="hint">Enter to run · Esc to close · it stops for anything that sends, pays or deletes, and waits for <kbd aria-label="${ACCEPT_KEY_NAME}">${ACCEPT_GLYPH}</kbd></div>
        </div>
      </div>
      <div class="panel" hidden>
        <header><span class="goal"></span><button class="stop">Stop</button></header>
        <ol></ol>
        <div class="summary" hidden></div>
        <div class="ask" hidden><div class="q"></div><input type="text" placeholder="Answer and press Enter" /></div>
      </div>`;
    this.scrim = root.querySelector(".scrim")!;
    this.input = root.querySelector(".box input")!;
    this.panel = root.querySelector(".panel")!;
    this.goalEl = root.querySelector(".goal")!;
    this.list = root.querySelector("ol")!;
    this.summary = root.querySelector(".summary")!;
    this.ask = root.querySelector(".ask")!;
    this.askInput = root.querySelector(".ask input")!;

    // Keys inside the overlay never reach the page — except the right Shift,
    // which is how a step is confirmed even while the question box has focus.
    for (const el of [this.input, this.askInput]) {
      el.addEventListener("keydown", (e) => {
        if (e.code === "ShiftRight") return;
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          if (el === this.input) this.close();
          else {
            this.hideAsk();
            this.onQuestionEscape();
          }
          return;
        }
        if (e.key !== "Enter") return;
        e.preventDefault();
        const text = el.value.trim();
        if (!text) return;
        el.value = "";
        if (el === this.input) {
          this.close();
          this.onSubmit(text);
        } else {
          this.hideAsk();
          this.onAnswer(text);
        }
      });
      el.addEventListener("keyup", (e) => e.code !== "ShiftRight" && e.stopPropagation());
      el.addEventListener("keypress", (e) => e.stopPropagation());
    }
    this.scrim.addEventListener("pointerdown", (e) => e.target === this.scrim && this.close());
    root.querySelector(".stop")!.addEventListener("click", () => this.onStop());
    document.documentElement.appendChild(this.host);
    // Carat's own surface: clicking in it is not the user getting on with the page.
    this.unregister ??= registerSurface(this.host);
  }

  open(): void {
    this.mount();
    this.scrim.hidden = false;
    this.input.value = "";
    this.input.focus();
  }

  close(): void {
    if (!this.host) return;
    this.scrim.hidden = true;
  }

  /** Start showing a task: clears the step list. */
  startTask(goal: string): void {
    this.mount();
    this.goalEl.textContent = goal;
    this.goalEl.title = goal;
    this.list.replaceChildren();
    this.summary.hidden = true;
    this.hideAsk();
    this.panel.hidden = false;
  }

  step(index: number, text: string, state: StepState, why = ""): void {
    if (!this.host) return;
    let li = this.list.children[index] as HTMLLIElement | undefined;
    if (!li) {
      li = document.createElement("li");
      this.list.appendChild(li);
    }
    li.dataset.state = state;
    li.replaceChildren(document.createTextNode(text));
    if (why) {
      const span = document.createElement("span");
      span.className = "why";
      span.textContent = ` — ${why}`;
      li.appendChild(span);
    }
    this.panel.scrollTop = this.panel.scrollHeight;
  }

  showQuestion(text: string): void {
    if (!this.host) return;
    this.ask.querySelector(".q")!.textContent = text;
    this.ask.hidden = false;
    this.askInput.focus();
  }

  /** Close the question box (the task moved on, or it was answered elsewhere). */
  hideQuestion(): void {
    this.hideAsk();
  }

  private hideAsk(): void {
    if (this.host) this.ask.hidden = true;
  }

  finish(summary: string): void {
    if (!this.host) return;
    this.hideAsk();
    this.summary.textContent = summary;
    this.summary.hidden = false;
  }

  hideTask(): void {
    if (this.host) this.panel.hidden = true;
  }

  /** Take the whole thing off the page (a content script starting over). */
  destroy(): void {
    this.unregister?.();
    this.unregister = null;
    this.host?.remove();
    this.host = null;
  }
}
