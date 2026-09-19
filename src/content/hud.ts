import type { AxSource, RequestStats, SessionStats } from "../shared/types.js";

interface HudState {
  visible: boolean;
  enabled: boolean;
  model: string;
  axSource: AxSource;
  stats: RequestStats | null;
  session: SessionStats | null;
  error: string | null;
  /** Suggestions served with no network round trip since the page loaded. */
  localHits: number;
  /** Last next-action prediction, e.g. "click Send reply (0.82)". */
  action: string | null;
}

const AX_LABEL: Record<AxSource, string> = {
  cdp: "CDP accessibility tree",
  fallback: "DOM fallback",
  none: "not attached",
};

export class Hud {
  private state: HudState = {
    visible: false,
    enabled: true,
    model: "",
    axSource: "none",
    stats: null,
    session: null,
    error: null,
    localHits: 0,
    action: null,
  };

  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private body: HTMLDivElement | null = null;
  private promptOpen = false;

  toggle(): void {
    this.state.visible = !this.state.visible;
    if (this.state.visible) this.ensure();
    this.render();
  }

  get visible(): boolean {
    return this.state.visible;
  }

  update(patch: Partial<HudState>): void {
    Object.assign(this.state, patch);
    if (this.state.visible) this.render();
  }

  countLocalHit(): void {
    this.state.localHits++;
    if (this.state.visible) this.render();
  }

  private ensure(): void {
    if (this.host) return;
    const host = document.createElement("div");
    host.setAttribute("data-carat", "hud");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all: initial; position: static;";
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      .panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 320px;
        max-height: 70vh;
        overflow: auto;
        z-index: 2147483647;
        background: #10131a;
        color: #e6ecf5;
        border: 1px solid #2a3344;
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,.45);
        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 10px 12px;
      }
      h1 { font-size: 12px; margin: 0 0 8px; letter-spacing: .08em; text-transform: uppercase; color: #7cc4ff; }
      dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; }
      dt { color: #8698b0; }
      dd { margin: 0; text-align: right; }
      .err { margin-top: 8px; color: #ff9a8a; word-break: break-word; }
      .off { color: #ffcf6b; }
      button {
        margin-top: 8px; width: 100%; font: inherit; cursor: pointer;
        background: #1a2130; color: #b9c8dd; border: 1px solid #2a3344;
        border-radius: 6px; padding: 4px 6px;
      }
      pre {
        margin: 8px 0 0; padding: 8px; background: #0a0d13; border-radius: 6px;
        white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto;
        color: #9fb3cc; font-size: 11px;
      }
      .hint { margin-top: 8px; color: #6b7b91; }
    `;

    const panel = document.createElement("div");
    panel.className = "panel";
    const title = document.createElement("h1");
    title.textContent = "Carat";
    this.body = document.createElement("div");
    panel.append(title, this.body);
    root.append(style, panel);

    // documentElement, not body: a transformed <body> would re-anchor position:fixed.
    document.documentElement.append(host);
    this.host = host;
    this.root = root;
  }

  private render(): void {
    if (!this.state.visible) {
      if (this.host) this.host.style.display = "none";
      return;
    }
    this.ensure();
    if (!this.host || !this.body || !this.root) return;
    this.host.style.display = "";

    const { stats, session } = this.state;
    const rows: [string, string][] = [
      ["status", this.state.enabled ? "on" : "off"],
      ["model", this.state.model || "-"],
      ["context", AX_LABEL[this.state.axSource]],
      ["ttft", stats ? (stats.cached ? "cached" : `${stats.ttft} ms`) : "-"],
      ["total", stats ? `${stats.total} ms` : "-"],
      ["outline", stats ? `${stats.outlineChars} chars` : "-"],
      ["median ttft", session ? `${session.medianTtft} ms` : "-"],
      ["requests", session ? String(session.requests) : "0"],
      ["accepted", session ? String(session.accepted) : "0"],
      ["no-network", String(this.state.localHits)],
      ["next action", this.state.action ?? "-"],
      ["predictions", session ? String(session.predictions) : "0"],
      ["actions taken", session ? String(session.actionsAccepted) : "0"],
    ];

    this.body.replaceChildren();

    const dl = document.createElement("dl");
    for (const [key, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (key === "status" && !this.state.enabled) dd.className = "off";
      dl.append(dt, dd);
    }
    this.body.append(dl);

    if (this.state.error) {
      const err = document.createElement("div");
      err.className = "err";
      err.textContent = this.state.error;
      this.body.append(err);
    }

    const toggle = document.createElement("button");
    toggle.textContent = this.promptOpen ? "hide prompt" : "show prompt sent";
    toggle.addEventListener("click", () => {
      this.promptOpen = !this.promptOpen;
      this.render();
    });
    this.body.append(toggle);

    if (this.promptOpen) {
      const pre = document.createElement("pre");
      pre.textContent = stats?.prompt || "(nothing sent yet)";
      this.body.append(pre);
    }

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Tab accept · Esc dismiss · Ctrl+. force (text or next action)";
    this.body.append(hint);
  }
}
