import type { StorageArea } from '../store';

/** Why the last suggestion request on a tab did or did not reach a provider. */
export type GateVerdict =
  | 'ok'
  | 'disabled'
  | 'site-off'
  | 'denylisted'
  | 'no-fields'
  | 'no-context'
  | 'own-context'
  | 'stale-context';

/** What happened to the last capture a tab sent. */
export type CaptureVerdict = 'stored' | 'disabled' | 'site-off' | 'denylisted' | 'pinned' | 'empty' | 'not-http';

export interface ProviderAttempt {
  id: 'openai' | 'baseten' | 'local';
  ms: number;
  count: number;
  error?: string;
}

export interface CaptureDiag {
  at: number;
  host: string;
  kind: 'page' | 'selection';
  verdict: CaptureVerdict;
}

export interface SuggestDiag {
  at: number;
  host: string;
  fields: number;
  /** Interactive elements the page described alongside its fields. */
  elements?: number;
  gate: GateVerdict;
  /** Set once the gate passed. */
  cached?: boolean;
  attempts?: ProviderAttempt[];
  /** Field fills handed to the content script after suppression. */
  offered?: number;
  /** Tab offers (open or switch) handed over alongside them. */
  navigation?: number;
  /** Element interactions (click, check, set, choose) handed over alongside them. */
  interactions?: number;
}

export interface TabDiag {
  capture?: CaptureDiag;
  suggest?: SuggestDiag;
}

const KEY = 'diag';
const MAX_TABS = 20;

/**
 * The last capture and suggestion outcome per tab, for the popup's debug
 * line. Lives in chrome.storage.session next to the context store so it
 * survives a service-worker restart but never the browser session. Holds
 * verdicts and timings only, never page text.
 */
export class DiagLog {
  private state: Record<string, TabDiag> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly area: StorageArea) {}

  async recordCapture(tabId: number, capture: CaptureDiag): Promise<void> {
    const state = await this.load();
    state[tabId] = { ...state[tabId], capture };
    this.write(tabId);
  }

  async recordSuggest(tabId: number, suggest: SuggestDiag): Promise<void> {
    const state = await this.load();
    state[tabId] = { ...state[tabId], suggest };
    this.write(tabId);
  }

  async get(tabId: number): Promise<TabDiag | undefined> {
    return (await this.load())[tabId];
  }

  /** Resolves once every queued write has reached the storage area. */
  flush(): Promise<void> {
    return this.chain;
  }

  private async load(): Promise<Record<string, TabDiag>> {
    if (this.state) return this.state;
    const raw = await this.area.get([KEY]);
    const v = raw[KEY];
    this.state = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, TabDiag>) : {};
    return this.state;
  }

  private write(touched: number): void {
    const state = this.state!;
    const ids = Object.keys(state).sort((a, b) => latest(state[b]!) - latest(state[a]!));
    for (const id of ids.slice(MAX_TABS)) if (id !== String(touched)) delete state[id];
    const snapshot = structuredClone(state);
    this.chain = this.chain.then(() => this.area.set({ [KEY]: snapshot })).catch(() => undefined);
  }
}

function latest(d: TabDiag): number {
  return Math.max(d.capture?.at ?? 0, d.suggest?.at ?? 0);
}
