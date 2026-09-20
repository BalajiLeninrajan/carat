import type { OutlineControl, PageScroll, Settings } from '@carat/shared';
import type { CdpEvidence, CdpNodeRef } from '../outline/cdp';
import { readCdpEvidence } from '../outline/cdp';
import { announceTarget, click, fill, focus, select } from '../interact/cdp-perform';
import type { ActuateResult } from '../interact/cdp-perform';
import { isSiteOff } from '../store/sites';
import { activated, attachable, closed, hasDebugger, isPaused, navigated, pauseReason, sender } from './cdp';

/** How long a tab's numbered nodes are worth performing against. */
export const EVIDENCE_TTL_MS = 120_000;

/** One numbered control, as the page needs it: the box the chip sits on. */
export interface EvidenceControlBox {
  n: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The control lives in a child frame, so the page cannot reach it and the debugger performs. */
  remote?: boolean;
}

/** What the page gets back when it asks the worker to read the tab through the debugger. */
export interface EvidenceReply {
  source: 'cdp' | 'dom';
  /** Why the DOM outline is being used. Absent when the debugger answered. */
  reason?: string;
  outline?: string;
  controls?: OutlineControl[];
  focused?: number;
  scroll?: PageScroll;
  boxes?: EvidenceControlBox[];
}

export type CdpAction = 'click' | 'fill' | 'select' | 'focus';

export interface CdpPerformReply {
  ok: boolean;
  reason?: string;
}

export interface PageEvidenceDeps {
  settings: () => Promise<Settings>;
  now?: () => number;
}

export interface PageEvidenceService {
  /** Read one tab through the debugger, or say why the page should build the outline itself. */
  read(tabId: number | undefined, url: string | undefined, opts?: { budget?: number }): Promise<EvidenceReply>;
  /** Dispatch the target event on control `n`, so the page's own listener picks the element up. */
  resolve(tabId: number | undefined, n: number, token: string): Promise<CdpPerformReply>;
  /** Carry the action out through the debugger, for a control the page could not reach. */
  perform(tabId: number | undefined, n: number, action: CdpAction, value: string): Promise<CdpPerformReply>;
  /** The user brought this tab forward: one that fell back may try the debugger again. */
  activated(tabId: number): void;
  /** The tab committed a navigation; carat lets the session go when the new URL is off limits. */
  navigated(tabId: number, url: string | undefined): void;
  forget(tabId: number): void;
}

/**
 * The debugger as carat's page evidence, with the DOM outline behind it.
 *
 * Reading a page needs `chrome.debugger`, which only the worker has, so the
 * content script asks here and gets the outline, the numbered controls and a
 * box per control back. What it never gets is the nodes themselves: the
 * backend node ids stay in the worker, and an accepted chip comes back by
 * number.
 *
 * Every refusal is a sentence, not a silence. A tab whose attach failed, whose
 * session the user dismissed, or whose host carat may not touch is told to
 * build the outline itself, with the reason, and the diag line prints it.
 */
export function createPageEvidence(deps: PageEvidenceDeps): PageEvidenceService {
  const now = deps.now ?? (() => Date.now());
  /** Per tab, the numbers the last read handed out and what they point at. */
  const registries = new Map<number, { at: number; nodes: Map<number, CdpNodeRef> }>();

  const dom = (reason: string): EvidenceReply => ({ source: 'dom', reason });

  async function read(tabId: number | undefined, url: string | undefined, opts: { budget?: number } = {}): Promise<EvidenceReply> {
    if (tabId === undefined) return dom('the page has no tab id');
    const settings = await deps.settings();
    if (settings.evidence !== 'debugger') return dom('the evidence setting is dom');
    if (!hasDebugger()) return dom('this browser has no debugger');
    if (!attachable(url)) return dom('carat does not attach to this page');
    try {
      const host = new URL(url!).host;
      if (isSiteOff(settings, host)) return dom('carat is off for this site');
    } catch {
      return dom('carat does not attach to this page');
    }
    const paused = pauseReason(tabId);
    if (paused !== undefined) return dom(paused);

    let evidence: CdpEvidence;
    try {
      evidence = await readCdpEvidence(sender(tabId), { ...(opts.budget !== undefined ? { budget: opts.budget } : {}), url: url! });
    } catch (err) {
      return dom(`the debugger would not attach: ${message(err)}`);
    }
    if (evidence.nodeCount === 0) return dom('the accessibility tree was empty');

    registries.set(tabId, { at: now(), nodes: evidence.nodes });
    sweep();
    return {
      source: 'cdp',
      outline: evidence.outline,
      controls: evidence.controls,
      ...(evidence.focused !== undefined ? { focused: evidence.focused } : {}),
      scroll: evidence.scroll,
      boxes: boxesOf(evidence.nodes),
    };
  }

  function nodeFor(tabId: number | undefined, n: number): CdpNodeRef | undefined {
    if (tabId === undefined) return undefined;
    const held = registries.get(tabId);
    if (!held || now() - held.at > EVIDENCE_TTL_MS) return undefined;
    return held.nodes.get(n);
  }

  async function resolve(tabId: number | undefined, n: number, token: string): Promise<CdpPerformReply> {
    const node = nodeFor(tabId, n);
    if (!node) return { ok: false, reason: 'that control is no longer numbered' };
    // A node in a child frame is performed by the debugger; the top frame's
    // listener would never hear the event anyway.
    if (node.frameId) return { ok: false, reason: 'the control is in a child frame' };
    try {
      await announceTarget(sender(tabId!), node.backendNodeId, token);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: message(err) };
    }
  }

  async function perform(tabId: number | undefined, n: number, action: CdpAction, value: string): Promise<CdpPerformReply> {
    const node = nodeFor(tabId, n);
    if (!node) return { ok: false, reason: 'that control is no longer numbered' };
    const send = sender(tabId!);
    try {
      const result = await run(send, node.backendNodeId, action, value);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    } catch (err) {
      return { ok: false, reason: message(err) };
    }
  }

  async function run(send: ReturnType<typeof sender>, backendNodeId: number, action: CdpAction, value: string): Promise<ActuateResult> {
    switch (action) {
      case 'click':
        return click(send, backendNodeId);
      case 'focus':
        return focus(send, backendNodeId);
      case 'fill':
        return fill(send, backendNodeId, value);
      case 'select':
        // A custom ARIA combobox is not a select; opening it is the next best thing.
        return (await select(send, backendNodeId, value)) ?? (await click(send, backendNodeId));
    }
  }

  function sweep(): void {
    const cutoff = now() - EVIDENCE_TTL_MS;
    for (const [tabId, held] of registries) if (held.at < cutoff) registries.delete(tabId);
  }

  return {
    read,
    resolve,
    perform,
    activated(tabId) {
      activated(tabId);
    },
    navigated(tabId, url) {
      registries.delete(tabId);
      navigated(tabId, url);
    },
    forget(tabId) {
      registries.delete(tabId);
      closed(tabId);
    },
  };
}

/** Only the geometry crosses to the page; the backend node ids stay in the worker. */
function boxesOf(nodes: ReadonlyMap<number, CdpNodeRef>): EvidenceControlBox[] {
  const out: EvidenceControlBox[] = [];
  for (const [n, ref] of nodes) {
    if (!ref.box) {
      if (ref.frameId) out.push({ n, x: 0, y: 0, w: 0, h: 0, remote: true });
      continue;
    }
    out.push({ n, x: ref.box.x, y: ref.box.y, w: ref.box.w, h: ref.box.h, ...(ref.frameId ? { remote: true } : {}) });
  }
  return out;
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

export { isPaused };
