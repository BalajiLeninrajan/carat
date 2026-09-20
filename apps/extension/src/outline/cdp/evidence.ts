import type { ControlRole, OutlineControl, PageScroll } from '@carat/shared';
import { isIrreversibleLabel } from '@carat/shared';
import type { AXNode } from './ax';
import { prop } from './ax';
import type { Box } from './layout';
import { boxFromModel, readLayout } from './layout';
import type { Candidate, Outline } from './outline';
import { buildOutline } from './outline';
import type { CdpViewport } from './viewport';
import { gateToViewport, scrollOf, viewportNotes } from './viewport';

/** Anything that answers a CDP method: one tab's debugger session, or a test's table of replies. */
export type CdpSend = <T = unknown>(method: string, params?: object) => Promise<T>;

/** Numbered controls whose box is fetched one at a time when there was no page snapshot to read it from. */
const MAX_BOX_FETCHES = 40;

/** Where a numbered control lives, for performing it through the debugger. */
export interface CdpNodeRef {
  backendNodeId: number;
  /** The CDP frame the node sits in, when that is not the top one. */
  frameId?: string;
  /** Its box in the top frame's viewport, when the page had geometry to give. */
  box?: Box;
}

export interface CdpEvidence {
  outline: string;
  controls: OutlineControl[];
  focused?: number;
  scroll: PageScroll;
  /** n -> the node behind it. The worker keeps it; only the boxes cross to the page. */
  nodes: Map<number, CdpNodeRef>;
  /** Accessibility nodes the tree came back with, for the diag line. */
  nodeCount: number;
}

export interface CdpReadOptions {
  budget?: number;
  /** The page's URL, for the outline's header line and for resolving a link's relative href. */
  url?: string;
  maxControls?: number;
}

/**
 * One page read through the debugger. Chrome's accessibility tree is the
 * evidence; `Page.getLayoutMetrics` says where the fold is and one
 * `DOMSnapshot.captureSnapshot` carries the boxes and the hrefs, so a page
 * that refuses either still produces an outline, only an ungated one.
 *
 * The walk itself is the prototype's, unchanged. Everything here is the join
 * between it and carat's contract: the viewport gate in front of it, the
 * screens lines around it, and its candidate list turned into the
 * `OutlineControl[]` the prompt, the validator and the chip already speak.
 */
export async function readCdpEvidence(send: CdpSend, opts: CdpReadOptions = {}): Promise<CdpEvidence> {
  const [tree, view, layout] = await Promise.all([
    // Not caught: this is the read. A tab carat cannot attach to fails here,
    // and the caller turns that into the reason the DOM outline stood in.
    send<{ nodes?: AXNode[] }>('Accessibility.getFullAXTree'),
    readViewport(send),
    readLayoutSnapshot(send),
  ]);
  const all = tree.nodes ?? [];
  const focusedBackendId = await findFocused(send, all);
  const { nodes, hidden } = gateToViewport(all, layout?.boxes, view, focusedBackendId);

  const built = buildOutline(nodes, {
    mode: 'action',
    url: opts.url ?? '',
    focusedBackendId,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.maxControls !== undefined ? { maxCandidates: opts.maxControls } : {}),
    ...(layout ? { hrefs: layout.hrefs } : {}),
    frameIds: framesOf(all),
  });

  const registry = new Map<number, CdpNodeRef>();
  for (const c of built.candidates) {
    registry.set(c.n, {
      backendNodeId: c.backendNodeId,
      ...(c.frameId ? { frameId: c.frameId } : {}),
      ...(layout?.boxes.get(c.backendNodeId) ? { box: layout.boxes.get(c.backendNodeId)! } : {}),
    });
  }
  if (!layout) await fillBoxes(send, registry);

  return {
    outline: withNotes(built.text, view, hidden),
    controls: built.candidates.map(toControl),
    ...(focusedOf(built) !== undefined ? { focused: focusedOf(built)! } : {}),
    scroll: scrollOf(view),
    nodes: registry,
    nodeCount: all.length,
  };
}

/** The `(N screens above)` and `(N.N more screens below; M controls not shown)` lines the DOM outline writes. */
function withNotes(text: string, view: CdpViewport | undefined, hidden: number): string {
  const notes = viewportNotes(view, hidden);
  return [notes.above, text, notes.below].filter((part): part is string => Boolean(part)).join('\n');
}

/** The prototype's roles, mapped onto the ones the prompt and the validator already speak. */
const ROLES: Record<string, ControlRole> = {
  textbox: 'textbox',
  searchbox: 'searchbox',
  combobox: 'combobox',
  spinbutton: 'textbox',
  button: 'button',
  link: 'link',
  checkbox: 'checkbox',
  menuitemcheckbox: 'checkbox',
  radio: 'radio',
  menuitemradio: 'radio',
  switch: 'switch',
  slider: 'slider',
  listbox: 'select',
  option: 'option',
  treeitem: 'option',
  tab: 'tab',
  menuitem: 'menuitem',
};

function toControl(c: Candidate): OutlineControl {
  return {
    n: c.n,
    role: ROLES[c.role] ?? 'other',
    name: c.name,
    ...(c.state ? { state: c.state } : {}),
    ...(c.host ? { host: c.host } : {}),
    ...(isIrreversibleLabel(c.name) ? { risky: true } : {}),
  };
}

/** Which number the outline marked `>> FOCUSED`, if the focused node was numbered at all. */
function focusedOf(built: Outline): number | undefined {
  const line = built.text.split('\n').find((l) => l.includes('>> FOCUSED '));
  const n = line ? /\[(\d+)\]/.exec(line)?.[1] : undefined;
  return n === undefined ? undefined : Number(n);
}

/**
 * backendNodeId -> the CDP frame it sits in, for everything below a frame root
 * other than the top one. A control in a child frame is performed through the
 * debugger in that frame rather than through the top frame's content script.
 */
function framesOf(nodes: readonly AXNode[]): Map<number, string> {
  const out = new Map<number, string>();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  if (!root) return out;
  const top = root.frameId;
  const visit = (node: AXNode, frameId: string | undefined, depth: number): void => {
    if (depth > 512) return;
    const here = node.frameId ?? frameId;
    if (node.backendDOMNodeId !== undefined && here !== undefined && here !== top) out.set(node.backendDOMNodeId, here);
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, here, depth + 1);
    }
  };
  visit(root, top, 0);
  return out;
}

interface LayoutMetrics {
  cssLayoutViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
  layoutViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
  cssContentSize?: { height?: number };
  contentSize?: { height?: number };
}

async function readViewport(send: CdpSend): Promise<CdpViewport | undefined> {
  try {
    const m = await send<LayoutMetrics>('Page.getLayoutMetrics');
    const view = m.cssLayoutViewport ?? m.layoutViewport;
    const content = m.cssContentSize ?? m.contentSize;
    if (!view?.clientHeight) return undefined;
    return {
      width: view.clientWidth ?? 0,
      height: view.clientHeight,
      scrollY: view.pageY ?? 0,
      pageHeight: content?.height ?? view.clientHeight,
    };
  } catch {
    return undefined;
  }
}

async function readLayoutSnapshot(send: CdpSend): Promise<ReturnType<typeof readLayout> | undefined> {
  try {
    const reply = await send<Parameters<typeof readLayout>[0]>('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    const layout = readLayout(reply);
    return layout.boxes.size > 0 || layout.hrefs.size > 0 ? layout : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The focused node. Chrome marks it in the tree, but only while the window has
 * focus, so when nothing is marked the DOM is asked outright. Straight from
 * the prototype's `axmirror.findFocused`.
 */
async function findFocused(send: CdpSend, nodes: readonly AXNode[]): Promise<number | null> {
  const marked = nodes.find((n) => !n.ignored && prop(n, 'focused') === true);
  if (marked?.backendDOMNodeId !== undefined) return marked.backendDOMNodeId;
  try {
    const { result } = await send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
      expression: 'document.activeElement === document.body ? null : document.activeElement',
    });
    if (!result?.objectId) return null;
    try {
      const { node } = await send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId: result.objectId });
      return node?.backendNodeId ?? null;
    } finally {
      void Promise.resolve(send('Runtime.releaseObject', { objectId: result.objectId })).catch(() => undefined);
    }
  } catch {
    return null;
  }
}

/**
 * Boxes for the numbered controls, one `DOM.getBoxModel` each, for when there
 * was no page snapshot to read them from. The chip needs somewhere to sit;
 * without a box it falls back to the banner, so this is a nicety rather than a
 * requirement, and it is capped and never allowed to fail the read.
 */
async function fillBoxes(send: CdpSend, nodes: Map<number, CdpNodeRef>): Promise<void> {
  const wanted = [...nodes.values()].filter((ref) => !ref.box && ref.backendNodeId > 0).slice(0, MAX_BOX_FETCHES);
  await Promise.all(
    wanted.map(async (ref) => {
      try {
        const model = await send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { backendNodeId: ref.backendNodeId });
        const box = boxFromModel(model);
        if (box) ref.box = box;
      } catch {
        // No box for this one: its chip sits at the bottom of the page instead.
      }
    }),
  );
}
