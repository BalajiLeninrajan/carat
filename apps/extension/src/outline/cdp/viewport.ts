import type { PageScroll } from '@carat/shared';
import type { AXNode } from './ax';
import type { Box } from './layout';

/** How far past the fold still counts as on screen, in viewports. The DOM outline's margin. */
export const FOLD_MARGIN = 0.25;

/** Where the page is scrolled to and how tall it is, in CSS pixels. */
export interface CdpViewport {
  width: number;
  height: number;
  scrollY: number;
  /** The whole document's height, for the "(N more screens below)" line. */
  pageHeight: number;
}

export interface Gated {
  /** The tree with every off-screen subtree taken out of it. */
  nodes: AXNode[];
  /** Controls those subtrees took with them, for the closing line. */
  hidden: number;
}

/** Roles that count as a control the user could have operated, for the closing line's tally. */
const OPERABLE = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'treeitem', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton',
]);

/**
 * Only what is on screen reaches the model, the same rule the DOM outline
 * follows: a node whose box lies entirely above the fold, more than a quarter
 * of a viewport below it, or off to the side is dropped along with everything
 * inside it, and the controls it took are counted rather than numbered.
 *
 * The walk in `outline.ts` is left alone for this: it is handed a tree that
 * already has the off-screen parts removed. A node with no box has no geometry
 * to be judged by and stays, which is what keeps a control inside a child
 * frame described whether or not the page snapshot could place it. The focused
 * node and everything holding it stay wherever they sit, because the button
 * that submits the field you are typing in is part of the same step.
 */
export function gateToViewport(
  nodes: readonly AXNode[],
  boxes: ReadonlyMap<number, Box> | undefined,
  view: CdpViewport | undefined,
  focusedBackendId: number | null,
): Gated {
  if (!boxes || !view || view.height <= 0) return { nodes: [...nodes], hidden: 0 };
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  if (!root) return { nodes: [...nodes], hidden: 0 };

  const fold = view.height * (1 + FOLD_MARGIN);
  const offScreen = (node: AXNode): boolean => {
    const box = node.backendDOMNodeId === undefined ? undefined : boxes.get(node.backendDOMNodeId);
    if (!box || box.w <= 0 || box.h <= 0) return false;
    if (box.y + box.h <= 0 || box.y >= fold) return true;
    return box.x + box.w <= 0 || box.x >= view.width;
  };

  const holdsFocus = new Set<string>();
  if (focusedBackendId !== null) {
    let node = nodes.find((n) => n.backendDOMNodeId === focusedBackendId);
    for (let hops = 0; node && hops < 64; hops++) {
      holdsFocus.add(node.nodeId);
      node = node.parentId === undefined ? undefined : byId.get(node.parentId);
    }
  }

  const kept: AXNode[] = [];
  let hidden = 0;
  const drop = (node: AXNode): void => {
    if (!node.ignored && OPERABLE.has(String(node.role?.value ?? ''))) hidden++;
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) drop(child);
    }
  };
  const visit = (node: AXNode, depth: number): void => {
    if (depth > 512) return;
    if (!holdsFocus.has(node.nodeId) && offScreen(node)) {
      drop(node);
      return;
    }
    kept.push(node);
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return { nodes: kept, hidden };
}

/**
 * What the model is not being shown: how far the page is scrolled, how much of
 * it is still below, both in viewports, and how many controls were left off
 * screen. Without these lines the model reads a page cut off at the fold as
 * the whole page, and never answers `scroll`.
 */
export function viewportNotes(view: CdpViewport | undefined, hidden: number): { above?: string; below?: string } {
  const notes: { above?: string; below?: string } = {};
  if (!view || view.height <= 0) {
    if (hidden > 0) notes.below = `(${hidden} control${hidden === 1 ? '' : 's'} not shown)`;
    return notes;
  }
  const above = view.scrollY / view.height;
  const below = (view.pageHeight - view.scrollY - view.height) / view.height;
  if (above >= 0.05) notes.above = `(${above.toFixed(1)} screens above)`;
  const rest = below >= 0.05 ? `${below.toFixed(1)} more screens below` : '';
  const unseen = hidden > 0 ? `${hidden} control${hidden === 1 ? '' : 's'} not shown` : '';
  if (rest || unseen) notes.below = `(${[rest, unseen].filter(Boolean).join('; ')})`;
  return notes;
}

/** Where the page is scrolled to, in viewports to one decimal, as the DOM path reports it. */
export function scrollOf(view: CdpViewport | undefined): PageScroll {
  if (!view || view.height <= 0) return { y: 0, pages: 1, more: false };
  const y = Number((view.scrollY / view.height).toFixed(1));
  const pages = Number((Math.max(view.pageHeight, view.height) / view.height).toFixed(1));
  return { y, pages, more: view.pageHeight - view.scrollY - view.height > view.height * 0.1 };
}
