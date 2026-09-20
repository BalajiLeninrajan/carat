/**
 * chrome.debugger session management: one CDP session per tab, attached on
 * first use and kept open while the tab is in use.
 *
 * If the user dismisses Chrome's "started debugging this browser" banner,
 * every session is detached with reason "canceled_by_user". Carat then marks
 * those tabs paused (badge "OFF") rather than immediately re-attaching, which
 * would just bring the banner straight back. The popup's Resume button and
 * Alt+Shift+C both clear it.
 */

const PROTOCOL_VERSION = "1.3";
/** Detach after this long without a command, so the banner goes away when idle. */
const IDLE_DETACH_MS = 5 * 60_000;
const PAUSED_KEY = "pausedTabs";

export class CdpPausedError extends Error {
  constructor(tabId: number) {
    super(`Carat is paused on tab ${tabId} (debugger was detached by the user)`);
  }
}

const sessions = new Map<number, Promise<void>>();
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The paused tabs, each with the origin it was paused on. Session storage, so
 * the pause outlives a worker restart; the origin is what later tells a
 * navigation away from that site from a click within it.
 */
async function pausedTabs(): Promise<Map<number, string>> {
  const stored = (await chrome.storage.session.get(PAUSED_KEY)) as Record<string, Record<string, string> | undefined>;
  return new Map(Object.entries(stored[PAUSED_KEY] ?? {}).map(([id, origin]) => [Number(id), origin]));
}

async function setPaused(tabIds: number[], paused: boolean, origin = ""): Promise<void> {
  const tabs = await pausedTabs();
  for (const id of tabIds) {
    if (paused) tabs.set(id, origin);
    else tabs.delete(id);
    chrome.action.setBadgeText({ tabId: id, text: paused ? "OFF" : "" }).catch(() => {});
    chrome.action
      .setTitle({ tabId: id, title: paused ? "Carat is paused on this tab. Open Carat to resume." : "Carat" })
      .catch(() => {});
  }
  await chrome.storage.session.set({ [PAUSED_KEY]: Object.fromEntries(tabs) });
}

export async function isPaused(tabId: number): Promise<boolean> {
  return (await pausedTabs()).has(tabId);
}

function originOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").origin;
  } catch {
    return "";
  }
}

/** Cancel was pressed on the debugging bar over this tab: stop reading it until told otherwise. */
export async function pause(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  await setPaused([tabId], true, originOf(tab?.url));
}

export function resume(tabId: number): Promise<void> {
  return setPaused([tabId], false);
}

async function attach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    // After a service-worker restart our previous session can still be live.
    // If it is someone else's, the first command will fail and surface that.
    if (!/already attached/i.test(errorMessage(e))) throw e;
  }
  // Keeps accessibility computed between fetches, which makes repeat
  // getFullAXTree calls much cheaper.
  await chrome.debugger.sendCommand({ tabId }, "Accessibility.enable");
}

async function ensureAttached(tabId: number): Promise<void> {
  if (await isPaused(tabId)) throw new CdpPausedError(tabId);
  let session = sessions.get(tabId);
  if (!session) {
    session = attach(tabId);
    sessions.set(tabId, session);
    session.catch(() => sessions.delete(tabId));
  }
  return session;
}

function touch(tabId: number): void {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.set(
    tabId,
    setTimeout(() => detach(tabId), IDLE_DETACH_MS),
  );
}

/** Send a CDP command to a tab, attaching first if needed. */
export async function send<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
  await ensureAttached(tabId);
  touch(tabId);
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown>)) as T;
  } catch (e) {
    // The session died underneath us (worker restart, tab crash): reattach once.
    if (!/not attached/i.test(errorMessage(e))) throw e;
    sessions.delete(tabId);
    await ensureAttached(tabId);
    return (await chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown>)) as T;
  }
}

export async function detach(tabId: number): Promise<void> {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  if (!sessions.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

/** Called with the tab id whenever a session ends for any reason. */
const detachListeners: ((tabId: number) => void)[] = [];
export function onSessionEnd(listener: (tabId: number) => void): void {
  detachListeners.push(listener);
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  sessions.delete(tabId);
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  for (const l of detachListeners) l(tabId);
  console.info(`[carat] debugger detached from tab ${tabId}: ${reason}`);
  if (reason === "canceled_by_user") void pause(tabId);
});

/**
 * Dismissing the banner was about the page it appeared over, not about the
 * tab forever. Leaving that site clears the pause, so carat comes back on its
 * own instead of staying dead for the rest of the session. Clicking around
 * the same site does not: that is still the page the user objected to.
 */
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  void (async () => {
    const pausedOn = (await pausedTabs()).get(tabId);
    if (pausedOn === undefined) return;
    const now = originOf(url);
    if (now === "" || now === pausedOn) return;
    console.info(`[carat] tab ${tabId} left ${pausedOn || "an unknown page"}; carat is running there again`);
    await resume(tabId);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  for (const l of detachListeners) l(tabId);
  setPaused([tabId], false);
});
