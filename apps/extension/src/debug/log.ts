import type { ActionKind } from '../engine/shared/protocol';
import type { ResponsesRequest } from '../engine/background/prompts';

/** Session key for what the debug panel reads. */
export const DEBUG_KEY = 'debugTrace';

/** The command that opens and closes the panel; `Alt+Shift+D` in the manifest. */
export const DEBUG_COMMAND = 'toggleDebug';

export const DEBUG_LIMITS = {
  /** Tabs that may hold a trace at once; the least recently touched goes first. */
  tabs: 5,
  /** Events kept per tab, newest last. */
  events: 50,
  /** The outline is already capped at 9000 by the request itself; this is the backstop. */
  outlineChars: 12_000,
  /** The model's reply as it streamed. */
  rawChars: 4000,
} as const;

/**
 * The action request exactly as the engine sent it. The user turn is the whole
 * `<page><browser><notes><history>` block; the few-shots and the instructions
 * are static and are not worth a copy per tab.
 */
export interface DebugRequest {
  at: number;
  model: string;
  /** The last input message: the page, the tabs, the notes and the history. */
  userTurn: string;
  /** `prompt_cache_key`, one per origin and path. */
  promptCacheKey: string;
  candidates: number;
  /** What the copy button puts on the clipboard. */
  json: string;
}

/** What came back from the model, and what the engine made of it. */
export interface DebugAnswer {
  at: number;
  /** The model's reply exactly as it streamed. */
  raw: string;
  kind: ActionKind | null;
  /** The `[n]` the model named, or the `[Tn]` for a tab switch. */
  target: number | null;
  label: string;
  value: string;
  irreversible: boolean;
  /** ms to the first output token, to the ring, and to the end of the stream. */
  ttftMs: number | null;
  targetMs: number | null;
  totalMs: number | null;
  usage: { input: number; cached: number; output: number } | null;
  /** `shown`, `cleared: no such target`, `cleared: unparseable`, `salvaged`. */
  outcome: string;
}

/** Something worth a line in the panel's timeline. */
export interface DebugEvent {
  at: number;
  /** `engine` is the service worker, `page` the content script. */
  source: 'engine' | 'page';
  name: string;
  detail?: string;
}

export interface TabDebug {
  /** The panel has been opened on this tab at least once; nothing is collected before that. */
  on: boolean;
  request?: DebugRequest;
  answer?: DebugAnswer;
  events: DebugEvent[];
}

/** Every precondition in front of a request, with the value it had. */
export interface DebugGate {
  host: string;
  enabled: boolean;
  blocked: boolean;
  keySet: boolean;
  /** The user dismissed Chrome's debugging banner on this tab. */
  paused: boolean;
}

/** Everything the background can tell the panel about one tab. */
export interface DebugSnapshot {
  at: number;
  tabId: number | null;
  on: boolean;
  debug: TabDebug | null;
  /** The engine's history lines for this tab, already formatted for a prompt. */
  history: string;
  gate: DebugGate;
}

/** The slice of `chrome.storage.session` this needs, so a test can hand in a map. */
export interface DebugArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

type State = Record<string, TabDebug>;

const EMPTY: TabDebug = { on: false, events: [] };

/**
 * What the debug panel reads, per tab, in `chrome.storage.session`. Off by
 * default and off again when the panel closes: until a tab's panel has been
 * opened, nothing here is written. Holds the request as it was sent, the
 * answer as it came back and a bounded ring of events. No value the content
 * script withheld: a redacted field never leaves the page in the first place.
 */
export class DebugLog {
  private state: State | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly area: DebugArea) {}

  /** The panel opened. From here the tab's requests and answers are kept. */
  async open(tabId: number): Promise<void> {
    const state = await this.load();
    state[tabId] = { ...EMPTY, ...state[tabId], on: true };
    this.write(tabId);
  }

  /** The panel closed. Collecting stops and what was collected goes with it. */
  async close(tabId: number): Promise<void> {
    const state = await this.load();
    if (!state[tabId]) return;
    delete state[tabId];
    this.write(tabId);
  }

  async isOn(tabId: number | undefined): Promise<boolean> {
    if (tabId === undefined) return false;
    return (await this.load())[tabId]?.on === true;
  }

  /** The request as it went out. Ignored when the tab's panel is not open. */
  async recordRequest(tabId: number, request: DebugRequest): Promise<void> {
    const state = await this.load();
    const current = state[tabId];
    if (!current?.on) return;
    state[tabId] = { ...current, request: trimRequest(request), answer: undefined };
    this.write(tabId);
  }

  /** The answer, once the exchange is over. Ignored when the tab's panel is not open. */
  async recordAnswer(tabId: number, answer: DebugAnswer): Promise<void> {
    const state = await this.load();
    const current = state[tabId];
    if (!current?.on) return;
    state[tabId] = { ...current, answer: trimAnswer(answer) };
    this.write(tabId);
  }

  /** One line for the timeline. Ignored when the tab's panel is not open. */
  async recordEvent(tabId: number, event: DebugEvent): Promise<void> {
    const state = await this.load();
    const current = state[tabId];
    if (!current?.on) return;
    state[tabId] = { ...current, events: [...current.events, event].slice(-DEBUG_LIMITS.events) };
    this.write(tabId);
  }

  async get(tabId: number): Promise<TabDebug | null> {
    return (await this.load())[tabId] ?? null;
  }

  /** Resolves once every queued write has reached the storage area. */
  flush(): Promise<void> {
    return this.chain;
  }

  private async load(): Promise<State> {
    if (this.state) return this.state;
    const raw = (await this.area.get([DEBUG_KEY]))[DEBUG_KEY];
    this.state = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as State) : {};
    return this.state;
  }

  private write(touched: number): void {
    const state = this.state!;
    for (const id of Object.keys(state).slice(DEBUG_LIMITS.tabs)) if (id !== String(touched)) delete state[id];
    const snapshot = structuredClone(state);
    this.chain = this.chain.then(() => this.area.set({ [DEBUG_KEY]: snapshot })).catch(() => undefined);
  }
}

/** The request the engine is about to send, as the panel wants it. */
export function describeRequest(request: ResponsesRequest, candidates: number, now = Date.now()): DebugRequest {
  const last = request.input[request.input.length - 1];
  return {
    at: now,
    model: request.model,
    userTurn: last?.content ?? '',
    promptCacheKey: request.prompt_cache_key ?? '',
    candidates,
    json: JSON.stringify(request, null, 2),
  };
}

/** `Alt+Shift+D` on a tab: the panel there opens, or closes if it was open. */
export function handleDebugCommand(
  command: string,
  tabId: number | undefined,
  deps: { toggle: (tabId: number) => void },
): boolean {
  if (command !== DEBUG_COMMAND || tabId === undefined) return false;
  deps.toggle(tabId);
  return true;
}

function trimRequest(request: DebugRequest): DebugRequest {
  if (request.userTurn.length <= DEBUG_LIMITS.outlineChars) return request;
  return { ...request, userTurn: request.userTurn.slice(0, DEBUG_LIMITS.outlineChars) };
}

function trimAnswer(answer: DebugAnswer): DebugAnswer {
  if (answer.raw.length <= DEBUG_LIMITS.rawChars) return answer;
  return { ...answer, raw: answer.raw.slice(0, DEBUG_LIMITS.rawChars) };
}
