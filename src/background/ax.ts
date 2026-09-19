import { TARGET_EVENT, type AxSource } from "../shared/types.js";

/** Subset of CDP's Accessibility.AXNode that we actually read. */
export interface AXValue {
  type: string;
  value?: unknown;
}

export interface AXProperty {
  name: string;
  value: AXValue;
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

const PROTOCOL = "1.3";
/** A tree a couple of seconds stale is fine, and keeps the hot path to one network call. */
const TREE_TTL_MS = 4000;
const IDLE_DETACH_MS = 3 * 60 * 1000;

interface CacheEntry {
  url: string;
  at: number;
  nodes: AXNode[];
}

const attaching = new Map<number, Promise<boolean>>();
const attached = new Set<number>();
/** Tabs where the user dismissed the debugging banner — fall back, don't nag. */
const refused = new Set<number>();
const cache = new Map<number, CacheEntry>();
const lastUsed = new Map<number, number>();
const inFlight = new Map<number, Promise<AXNode[] | null>>();

function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const message = chrome.runtime.lastError?.message;
      if (message) reject(new Error(message));
      else resolve(result as T);
    });
  });
}

function attach(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL, () => {
      const message = chrome.runtime.lastError?.message;
      // "Another debugger is already attached" happens when DevTools is open.
      if (message && !/already attached/i.test(message)) reject(new Error(message));
      else resolve();
    });
  });
}

async function ensureAttached(tabId: number): Promise<boolean> {
  if (attached.has(tabId)) return true;
  if (refused.has(tabId)) return false;
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = (async () => {
      try {
        await attach(tabId);
        await sendCommand(tabId, "Accessibility.enable");
        attached.add(tabId);
        return true;
      } catch (err) {
        console.warn("[carat] debugger attach failed", err);
        refused.add(tabId);
        return false;
      } finally {
        attaching.delete(tabId);
      }
    })();
    attaching.set(tabId, pending);
  }
  return pending;
}

/**
 * The accessibility tree for a tab, or null when CDP is unavailable and the
 * caller should fall back to the content script's DOM+ARIA snapshot.
 */
export async function getAxTree(tabId: number, url: string): Promise<AXNode[] | null> {
  lastUsed.set(tabId, Date.now());

  const hit = cache.get(tabId);
  if (hit && hit.url === url && Date.now() - hit.at < TREE_TTL_MS) return hit.nodes;

  // Coalesce concurrent misses — fast typing can outrun a single fetch.
  const existing = inFlight.get(tabId);
  if (existing) return existing;

  const job = (async () => {
    if (!(await ensureAttached(tabId))) return null;
    try {
      const res = await sendCommand<{ nodes: AXNode[] }>(tabId, "Accessibility.getFullAXTree");
      const nodes = res?.nodes ?? [];
      cache.set(tabId, { url, at: Date.now(), nodes });
      return nodes;
    } catch (err) {
      console.warn("[carat] getFullAXTree failed", err);
      // Attachment may have died under us; let the next call retry once.
      attached.delete(tabId);
      return null;
    } finally {
      inFlight.delete(tabId);
    }
  })();

  inFlight.set(tabId, job);
  return job;
}

/**
 * Hand an accessibility node to the content script as a real DOM element.
 *
 * The content script cannot see CDP node ids, and the worker cannot touch the
 * DOM. So the worker resolves the node and dispatches an event *on* it; the
 * content script's capture listener receives the element as the event target.
 * Nothing is written into the page, and it works inside open shadow roots.
 */
export async function pointAtNode(
  tabId: number,
  backendNodeId: number,
  reqId: string,
): Promise<boolean> {
  if (!attached.has(tabId)) return false;
  try {
    const { object } = await sendCommand<{ object: { objectId?: string } }>(
      tabId,
      "DOM.resolveNode",
      { backendNodeId },
    );
    if (!object?.objectId) return false;
    await sendCommand(tabId, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function (id) {
        this.dispatchEvent(new CustomEvent(${JSON.stringify(TARGET_EVENT)}, {
          detail: id, bubbles: false, composed: true
        }));
      }`,
      arguments: [{ value: reqId }],
      silent: true,
    });
    void sendCommand(tabId, "Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    return true;
  } catch (err) {
    console.warn("[carat] could not point at node", err);
    return false;
  }
}

export function sourceFor(tabId: number): AxSource {
  if (attached.has(tabId)) return "cdp";
  if (refused.has(tabId)) return "fallback";
  return "none";
}

export function invalidate(tabId: number): void {
  cache.delete(tabId);
}

export async function detach(tabId: number): Promise<void> {
  cache.delete(tabId);
  lastUsed.delete(tabId);
  if (!attached.delete(tabId)) return;
  await new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/** Called when the user turns Carat off — give every tab its banner back. */
export async function detachAll(): Promise<void> {
  await Promise.all([...attached].map((tabId) => detach(tabId)));
  refused.clear();
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  cache.delete(source.tabId);
  // Canceling the infobar is a "no thanks" — stop reattaching to this tab.
  if (reason === "canceled_by_user") refused.add(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  refused.delete(tabId);
  cache.delete(tabId);
  lastUsed.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "loading") cache.delete(tabId);
});

// Idle tabs give their debugger session back so the banner does not linger.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "carat-ax-sweep") return;
  const now = Date.now();
  for (const tabId of [...attached]) {
    if (now - (lastUsed.get(tabId) ?? 0) > IDLE_DETACH_MS) void detach(tabId);
  }
});

chrome.alarms.create("carat-ax-sweep", { periodInMinutes: 1 });
