/**
 * The instruction box (Ctrl+Shift+K) and the panel that shows what the task is
 * doing, both in one closed shadow root.
 *
 * Keys typed in the box are stopped from reaching the page, so a site's own
 * shortcuts (and Carat's own suggestion handling) never see them. The host is
 * aria-hidden so none of this lands in the accessibility tree Carat reads.
 */

export type StepState = "running" | "done" | "failed" | "skipped" | "waiting";

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .scrim {
    position: fixed; inset: 0; display: grid; place-items: start center; padding-top: 18vh;
    background: rgba(17, 24, 39, .28); backdrop-filter: blur(1.5px);
  }
  .box {
    width: min(620px, 92vw); background: #fff; color: #111827; border-radius: 12px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, .35); overflow: hidden;
  }
  .row { display: flex; align-items: center; gap: 10px; padding: 14px 16px; }
  .mark { font: 600 13px/1 ui-monospace, Menlo, Consolas, monospace; color: #fff; background: #7c3aed;
          padding: 5px 7px; border-radius: 6px; }
  input {
    flex: 1; border: 0; outline: 0; font-size: 16px; color: inherit; background: transparent;
  }
  .hint { padding: 0 16px 12px; font-size: 12px; color: #6b7280; }
  .panel {
    position: fixed; right: 16px; bottom: 16px; width: 340px; max-height: 60vh; overflow: auto;
    background: #fff; color: #111827; border-radius: 10px; box-shadow: 0 10px 30px rgba(0, 0, 0, .25);
    font-size: 13px;
  }
  .panel header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
  .goal { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stop { border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 6px; padding: 3px 8px;
          font-size: 12px; cursor: pointer; }
  ol { margin: 0; padding: 8px 12px 10px 28px; }
  li { margin: 6px 0; }
  li .why { color: #6b7280; }
  li[data-state=running] { color: #7c3aed; }
  li[data-state=failed] { color: #b91c1c; }
  li[data-state=skipped] { color: #6b7280; text-decoration: line-through; }
  li[data-state=waiting] { color: #b45309; }
  .summary { padding: 8px 12px 12px; color: #374151; border-top: 1px solid #e5e7eb; }
  .ask { padding: 10px 12px; border-top: 1px solid #e5e7eb; }
  .ask input { border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 8px; width: 100%; font-size: 13px; }
  @media (prefers-color-scheme: dark) {
    .box, .panel { background: #111827; color: #f3f4f6; }
    .panel header, .summary, .ask { border-color: #374151; }
    .stop { background: #1f2937; color: #e5e7eb; border-color: #4b5563; }
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

  /** Called with the instruction the user typed. */
  onSubmit: (goal: string) => void = () => {};
  /** Called when the user answers a question the task asked. */
  onAnswer: (answer: string) => void = () => {};
  /** Called when the user presses Esc in the question box. */
  onQuestionEscape: () => void = () => {};
  onStop: () => void = () => {};

  get element(): HTMLElement | null {
    return this.host;
  }
  get isOpen(): boolean {
    return !!this.host && !this.scrim.hidden;
  }
  get hasTask(): boolean {
    return !!this.host && !this.panel.hidden;
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
          <div class="hint">Enter to run · Esc to close · it stops for anything that sends, pays or deletes</div>
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

    // Keys inside the overlay never reach the page — except right Shift, which
    // is how a step is confirmed even while the question box has focus.
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

  question(text: string): void {
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
}
