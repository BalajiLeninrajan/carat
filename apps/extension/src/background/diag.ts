import type { Eagerness, NextActionKind, Settings } from '@carat/shared';
import type { StorageArea } from '../store';

/** Why the last request on a tab did or did not reach a provider. */
export type GateVerdict = 'ok' | 'disabled' | 'site-off' | 'denylisted' | 'password' | 'no-snapshot';

/** What happened to the last capture a tab sent. */
export type CaptureVerdict = 'stored' | 'disabled' | 'site-off' | 'denylisted' | 'pinned' | 'empty' | 'not-http';

/**
 * What happened to the last screenshot cue from a tab. `shot`: a picture was
 * taken and parked. `reading`: it went to the vision model. `transcribed`:
 * the text landed and was distilled into notes. The rest say why nothing happened.
 */
export type VisionVerdict =
  | 'shot'
  | 'reading'
  | 'transcribed'
  | 'dropped'
  | 'disabled'
  | 'screenshots-off'
  | 'site-off'
  | 'denylisted'
  | 'pinned'
  | 'not-http'
  | 'not-in-front'
  | 'capture-failed'
  | 'no-shot'
  | 'no-model'
  | 'short'
  | 'failed';

export interface VisionDiag {
  at: number;
  host: string;
  verdict: VisionVerdict;
}

export interface ProviderAttempt {
  id: Settings['provider'];
  ms: number;
  /** The kind it answered with, or '-' when it had nothing. */
  kind: string;
  error?: string;
}

export interface CaptureDiag {
  at: number;
  host: string;
  kind: 'page' | 'selection';
  verdict: CaptureVerdict;
}

/** Where the action the chip showed first came from. */
export type AnswerOrigin = 'cache' | 'placeholder' | 'model';

export interface SuggestDiag {
  at: number;
  host: string;
  /** Numbered controls in the outline the request carried. */
  controls: number;
  gate: GateVerdict;
  /** What produced the first action, and how long the content script waited for it. */
  source?: AnswerOrigin;
  ms?: number;
  attempts?: ProviderAttempt[];
  /** The level the request ran at; names the floor an action fell under. */
  eagerness?: Eagerness;
  /** The action the chip was given: its kind, the model's own label and reason. */
  kind?: NextActionKind;
  label?: string;
  reason?: string;
  confidence?: number;
  /** The chip asks for a second Tab before it acts. */
  irreversible?: boolean;
  /** The user armed it with that first Tab. */
  armed?: boolean;
  /** Why an otherwise valid action was refused: under the floor, a control that is not there, a scroll with nothing below. */
  refused?: string;
  /** A better answer may still come; the content script polls for it. */
  refine?: boolean;
  /** The model replaced what the placeholder had put up. */
  replaced?: boolean;
}

/**
 * One thing carat performed on a tab that is worth remembering: a money
 * control accepted with Enter (always logged, with the button's name), or a
 * fill that stopped short of the pick that should have followed it. The
 * later goal layer reads these to know where a flow stands.
 */
export interface PerformDiag {
  at: number;
  host: string;
  kind: 'money' | 'fill';
  /** The button's accessible name, or the field id for a partial fill. */
  name: string;
  outcome: 'done' | 'partial';
}

export interface TabDiag {
  capture?: CaptureDiag;
  suggest?: SuggestDiag;
  vision?: VisionDiag;
  /** Newest last, at most MAX_PERFORMS. */
  performs?: PerformDiag[];
}

const KEY = 'diag';
const MAX_TABS = 20;
export const MAX_PERFORMS = 8;

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

  /** A request reports once when it replies and again when its ticket closes; a newer check's line is never overwritten by an older one's. */
  async recordSuggest(tabId: number, suggest: SuggestDiag): Promise<void> {
    const state = await this.load();
    const current = state[tabId]?.suggest;
    if (current && current.at > suggest.at) return;
    state[tabId] = { ...state[tabId], suggest };
    this.write(tabId);
  }

  async recordVision(tabId: number, vision: VisionDiag): Promise<void> {
    const state = await this.load();
    state[tabId] = { ...state[tabId], vision };
    this.write(tabId);
  }

  async recordPerform(tabId: number, perform: PerformDiag): Promise<void> {
    const state = await this.load();
    const performs = [...(state[tabId]?.performs ?? []), perform].slice(-MAX_PERFORMS);
    state[tabId] = { ...state[tabId], performs };
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
  return Math.max(
    d.capture?.at ?? 0,
    d.suggest?.at ?? 0,
    d.vision?.at ?? 0,
    d.performs?.at(-1)?.at ?? 0,
  );
}
