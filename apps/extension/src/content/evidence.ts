import { LIMITS, normalizeWhitespace, truncate } from '@carat/shared';
import type { EvidenceControlBox, EvidenceReply } from '../background/page-evidence';
import { TARGET_EVENT } from '../interact/cdp-perform';
import type { Evidence, OutlineTarget, RequestMeta } from '../outline';
import { assembleEvidence, scrollOf, snapshotHash } from '../outline';
import type { ScriptContext } from './context';
import { send } from './send';

/** What the page read, and which of the two sources produced it. */
export interface ReadEvidence extends Evidence {
  source: 'cdp' | 'dom';
  /** Why the DOM outline stood in. Absent when the debugger answered. */
  reason?: string;
}

/**
 * The element the worker last pointed at through the debugger, and the token
 * of the request that asked for it. The worker dispatches a custom event on
 * the node; this listens for it in the page, which is how a control numbered
 * from Chrome's accessibility tree becomes an element the page's own fill and
 * click paths can work on.
 */
export interface CdpTargets {
  /** The element announced under `token`, if that announcement is the current one. */
  take(token: string): Element | null;
}

export function startCdpTargets(ctx: ScriptContext, doc: Document = document): CdpTargets {
  let last: { token: string; el: Element } | null = null;
  ctx.addEventListener(
    doc,
    TARGET_EVENT,
    (e: Event) => {
      const token = (e as CustomEvent<string>).detail;
      const el = (e.composedPath?.()[0] ?? e.target) as Element | null;
      if (typeof token === 'string' && el instanceof Element) last = { token, el };
    },
    { capture: true } as AddEventListenerOptions,
  );
  return {
    take(token) {
      if (!last || last.token !== token) return null;
      const el = last.el;
      last = null;
      return el.isConnected ? el : null;
    },
  };
}

export interface ReadOptions extends RequestMeta {
  /** Ask the worker to read the tab through the debugger first. Off falls straight to the DOM. */
  debugger?: boolean;
}

/**
 * Everything about the page the engine needs, read through Chrome's
 * accessibility tree when the worker can hold a debugger over this tab, and
 * through the DOM when it cannot. The two produce the same `PageEvidence`, so
 * nothing downstream knows or cares which answered; only the diag line says.
 *
 * A control numbered from the accessibility tree has no element here. The
 * registry holds its number and the box the worker measured, which is enough
 * for the chip to sit on it; performing goes back through the worker, by
 * number, to the exact node behind it.
 */
export async function readEvidence(doc: Document, win: Window | null, opts: ReadOptions = {}): Promise<ReadEvidence> {
  const { debugger: useDebugger = true, ...meta } = opts;
  if (useDebugger) {
    const reply = await ask(meta.budget);
    if (reply?.source === 'cdp' && reply.outline !== undefined) return fromWorker(reply, doc, win, meta);
    const dom = assembleEvidence(doc, win, meta);
    return { ...dom, source: 'dom', reason: reply?.reason ?? 'the worker did not answer' };
  }
  return { ...assembleEvidence(doc, win, meta), source: 'dom', reason: 'the evidence setting is dom' };
}

async function ask(budget: number | undefined): Promise<EvidenceReply | undefined> {
  try {
    return await send('cdpEvidence', budget === undefined ? {} : { budget });
  } catch {
    return undefined;
  }
}

function fromWorker(reply: EvidenceReply, doc: Document, win: Window | null, meta: RequestMeta): ReadEvidence {
  const location = meta.location ?? doc.location;
  const outline = reply.outline ?? '';
  const registry = new Map<number, OutlineTarget>();
  const boxes = new Map<number, EvidenceControlBox>();
  for (const box of reply.boxes ?? []) boxes.set(box.n, box);
  for (const control of reply.controls ?? []) {
    const box = boxes.get(control.n);
    registry.set(control.n, {
      cdp: {
        n: control.n,
        ...(box && box.w > 0 && box.h > 0 ? { rect: new DOMRect(box.x, box.y, box.w, box.h) } : {}),
        ...(box?.remote ? { remote: true } : {}),
      },
    });
  }
  return {
    request: {
      page: {
        host: location.host,
        title: truncate(normalizeWhitespace(doc.title), LIMITS.titleChars),
        path: location.pathname,
        scroll: reply.scroll ?? scrollOf(doc, win),
      },
      outline,
      controls: reply.controls ?? [],
      ...(reply.focused !== undefined ? { focused: reply.focused } : {}),
    },
    registry,
    hash: snapshotHash(outline),
    source: 'cdp',
  };
}
