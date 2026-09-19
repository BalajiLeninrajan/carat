/**
 * The worker's copy of each tab's accessibility tree.
 *
 * Fetching is the slow part (tens to hundreds of ms on a heavy page), so the
 * tree is cached per tab and only refetched when the content script reports
 * that the page changed, or the URL moved. Typing in the focused field does not
 * count as a change: its value comes from the content script instead.
 */

import { prop, type AXNode } from "./ax.js";
import { onSessionEnd, send } from "./cdp.js";

export interface AXSnapshot {
  url: string;
  nodes: AXNode[];
  fetchedAt: number;
  /** How long Accessibility.getFullAXTree took. */
  fetchMs: number;
  /** backendDOMNodeId of the focused element, if any. */
  focusedBackendId: number | null;
}

const cache = new Map<number, AXSnapshot>();
const inflight = new Map<number, Promise<AXSnapshot>>();

onSessionEnd((tabId) => {
  cache.delete(tabId);
  inflight.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" || info.url) cache.delete(tabId);
});

/**
 * The focused element's backend id. Chrome marks it with the AX `focused`
 * property, but only while the page's window has focus, so when that is
 * missing (or the nodes are a cached copy) we ask the DOM directly.
 */
async function findFocused(tabId: number, freshNodes: AXNode[] | null): Promise<number | null> {
  const marked = freshNodes?.find((n) => !n.ignored && prop(n, "focused") === true);
  if (marked?.backendDOMNodeId) return marked.backendDOMNodeId;

  const { result } = await send<{ result: { objectId?: string; subtype?: string } }>(
    tabId,
    "Runtime.evaluate",
    { expression: "document.activeElement === document.body ? null : document.activeElement" },
  );
  if (!result.objectId) return null;
  try {
    const { node } = await send<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", {
      objectId: result.objectId,
    });
    return node.backendNodeId;
  } finally {
    send(tabId, "Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
  }
}

async function fetchTree(tabId: number, url: string): Promise<AXSnapshot> {
  const started = performance.now();
  const { nodes } = await send<{ nodes: AXNode[] }>(tabId, "Accessibility.getFullAXTree");
  const fetchMs = Math.round(performance.now() - started);
  const focusedBackendId = await findFocused(tabId, nodes);
  return { url, nodes, fetchedAt: Date.now(), fetchMs, focusedBackendId };
}

/**
 * The tab's tree, from cache when it is still valid. Concurrent callers share
 * one fetch.
 */
export async function getTree(
  tabId: number,
  url: string,
  pageChanged: boolean,
): Promise<{ snapshot: AXSnapshot; cached: boolean }> {
  const hit = cache.get(tabId);
  if (hit && hit.url === url && !pageChanged) {
    // Focus can move without the page changing (clicking into another field).
    hit.focusedBackendId = await findFocused(tabId, null);
    return { snapshot: hit, cached: true };
  }

  let pending = inflight.get(tabId);
  if (!pending) {
    pending = fetchTree(tabId, url).finally(() => inflight.delete(tabId));
    inflight.set(tabId, pending);
  }
  const snapshot = await pending;
  cache.set(tabId, snapshot);
  return { snapshot, cached: false };
}
