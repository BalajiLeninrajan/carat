import type { NextAction, NextActionRequest, Settings } from '@carat/shared';
import { isDenylisted } from '@carat/shared';
import type { HistoryEntry } from '../history';
import { isSiteOff } from '../store/sites';
import type { StorageArea } from '../store/storage-area';
import type { GateVerdict, ProviderAttempt, TabDiag } from './diag';

/** Session key for what the debug panel reads, beside the diag log and the timeline. */
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

/** The request as it went out, plus the two keys that decide whether it was paid for twice. */
export interface DebugRequest {
  at: number;
  req: NextActionRequest;
  /** Carat's own 60 s answer cache key. */
  cacheKey: string;
  /** `prompt_cache_key`, one per origin and path. */
  promptCacheKey: string;
}

/** What came back, and what the validator made of it. */
export interface DebugAnswer {
  at: number;
  /** What the regex placeholder had, after validation. */
  placeholder: NextAction | null;
  /** What the chip was left with. */
  action: NextAction | null;
  /** The model's reply exactly as it streamed. */
  raw?: string;
  /** Whose answer the race stood on. */
  winner?: string;
  attempts: ProviderAttempt[];
  /** One line per validator pass: allowed, or refused and why. */
  validations: string[];
}

/** Something worth a line in the panel's timeline that is not already in the tab's history. */
export interface DebugEvent {
  at: number;
  /** `engine` is the service worker, `page` the content script's scheduler. */
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
  /** The verdict of the last request, or null when none has gone out. */
  verdict: GateVerdict | null;
  host: string;
  enabled: boolean;
  siteOn: boolean;
  denylisted: boolean;
  /** From the last request this tab sent; the page has the live answer. */
  password: boolean;
  snapshot: boolean;
}

/** Everything the background can tell the panel about one tab. */
export interface DebugSnapshot {
  at: number;
  tabId: number | null;
  on: boolean;
  diag: TabDiag | null;
  debug: TabDebug | null;
  history: HistoryEntry[];
  gate: DebugGate;
}

type State = Record<string, TabDebug>;

const EMPTY: TabDebug = { on: false, events: [] };

/**
 * What the debug panel reads, per tab, in `chrome.storage.session`. Off by
 * default and off again when the panel closes: until a tab's panel has been
 * opened, nothing here is written and the ordinary diag line is all that is
 * kept. Holds the request as it was sent, the answer as it came back and a
 * bounded ring of events. No screenshots, and no value the content script
 * withheld: secret fields never leave the page in the first place.
 */
export class DebugLog {
  private state: State | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly area: StorageArea) {}

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
    state[tabId] = { ...current, request: trimRequest(request) };
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

  forget(tabId: number): Promise<void> {
    return this.close(tabId);
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

export interface DebugSources {
  diag: { get(tabId: number): Promise<TabDiag | undefined> };
  debug: Pick<DebugLog, 'get'>;
  history: { entries(tabId: number): Promise<HistoryEntry[]> };
  settings: () => Promise<Settings>;
  /** The tab's host, for the gate's per-site and denylist rows. */
  host: (tabId: number) => Promise<string>;
  now?: () => number;
}

/**
 * One reply to `getDebug`, and the same shape the background pushes as
 * `debugEvent` while the panel is open. Every read is best effort: a debug
 * panel that cannot answer must never take a request down with it.
 */
export async function debugSnapshot(tabId: number | undefined, src: DebugSources): Promise<DebugSnapshot> {
  const at = (src.now ?? Date.now)();
  if (tabId === undefined) return { at, tabId: null, on: false, diag: null, debug: null, history: [], gate: blankGate('') };
  const [settings, diag, debug, history, host] = await Promise.all([
    src.settings(),
    src.diag.get(tabId).catch(() => undefined),
    src.debug.get(tabId).catch(() => null),
    src.history.entries(tabId).catch(() => []),
    src.host(tabId).catch(() => ''),
  ]);
  const where = host || diag?.suggest?.host || '';
  return {
    at,
    tabId,
    on: debug?.on === true,
    diag: diag ?? null,
    debug: debug ?? null,
    history,
    gate: {
      verdict: diag?.suggest?.gate ?? null,
      host: where,
      enabled: settings.enabled,
      siteOn: !isSiteOff(settings, where),
      denylisted: where ? isDenylisted(where) : false,
      password: diag?.suggest?.gate === 'password',
      snapshot: diag?.suggest ? diag.suggest.gate !== 'no-snapshot' : false,
    },
  };
}

function blankGate(host: string): DebugGate {
  return { verdict: null, host, enabled: false, siteOn: true, denylisted: false, password: false, snapshot: false };
}

function trimRequest(request: DebugRequest): DebugRequest {
  const outline = request.req.outline;
  if (outline.length <= DEBUG_LIMITS.outlineChars) return request;
  return { ...request, req: { ...request.req, outline: outline.slice(0, DEBUG_LIMITS.outlineChars) } };
}

function trimAnswer(answer: DebugAnswer): DebugAnswer {
  if (answer.raw === undefined || answer.raw.length <= DEBUG_LIMITS.rawChars) return answer;
  return { ...answer, raw: answer.raw.slice(0, DEBUG_LIMITS.rawChars) };
}
