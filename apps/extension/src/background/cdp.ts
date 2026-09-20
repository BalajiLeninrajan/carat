/**
 * `chrome.debugger` session management: one CDP session per tab, attached the
 * first time carat reads that tab and kept open while it keeps reading it.
 *
 * Ported from the prototype's `src/background/cdp.ts` on origin/testing, with
 * the rules carat needs on top: a shorter idle detach, a check on the URL
 * before attaching at all, a detach when the tab navigates somewhere carat may
 * not read, and a reason kept per tab so the fallback can say why it happened.
 *
 * If the user dismisses Chrome's "Chrome is being debugged by software"
 * banner, or opens DevTools, every session is detached with a reason. Carat
 * then marks that tab paused rather than attaching straight back, which would
 * only bring the banner back with it. The tab reads through the DOM outline
 * until the user next activates it.
 */

import { isDenylisted } from '@carat/shared';

export const PROTOCOL_VERSION = '1.3';

/** Detach after this long without a command, so the banner goes away when carat is idle. */
export const IDLE_DETACH_MS = 60_000;

/** Hosts whose pages are Chrome's own shop front: attaching there is refused outright. */
const STORE_HOSTS = new Set(['chrome.google.com', 'chromewebstore.google.com']);

export class CdpPausedError extends Error {
  constructor(tabId: number, readonly reason: string) {
    super(`carat is not using the debugger on tab ${tabId}: ${reason}`);
    this.name = 'CdpPausedError';
  }
}

/** The slice of `chrome.debugger` carat uses; a test hands in its own. */
export interface DebuggerApi {
  attach(target: { tabId: number }, version: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(target: { tabId: number }, method: string, params?: object): Promise<unknown>;
  onDetach: { addListener(cb: (source: { tabId?: number }, reason: string) => void): void };
}

const sessions = new Map<number, Promise<void>>();
const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
/** Tabs reading through the DOM outline until the user next activates them, and why. */
const paused = new Map<number, string>();

let api: DebuggerApi | null = null;
let listening = false;

/** Swap the debugger in, for a test or for a worker that has none. Returns the one replaced. */
export function useDebuggerApi(next: DebuggerApi | null): DebuggerApi | null {
  const before = api;
  api = next;
  listening = false;
  sessions.clear();
  for (const timer of idleTimers.values()) clearTimeout(timer);
  idleTimers.clear();
  paused.clear();
  if (next) listen(next);
  return before;
}

function debuggerApi(): DebuggerApi {
  if (api) return api;
  const real = (globalThis as { chrome?: { debugger?: DebuggerApi } }).chrome?.debugger;
  if (!real) throw new Error('this browser has no chrome.debugger');
  api = real;
  listen(real);
  return real;
}

/** Whether the debugger is there at all; without it every tab reads through the DOM. */
export function hasDebugger(): boolean {
  if (api) return true;
  return Boolean((globalThis as { chrome?: { debugger?: unknown } }).chrome?.debugger);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Whether carat may attach to this URL at all. Chrome's own pages and the Web
 * Store refuse a debugger, and a denylisted host is one carat does not read by
 * any route, so neither is ever worth the banner.
 */
export function attachable(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (STORE_HOSTS.has(u.hostname)) return false;
    return !isDenylisted(u.hostname);
  } catch {
    return false;
  }
}

async function attach(tabId: number): Promise<void> {
  const d = debuggerApi();
  try {
    await d.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    // After a worker restart our previous session can still be live. If it is
    // someone else's, the first command fails and surfaces that instead.
    if (!/already attached/i.test(errorMessage(e))) throw e;
  }
  // Keeps the accessibility tree computed between fetches, which makes repeat
  // getFullAXTree calls much cheaper.
  await d.sendCommand({ tabId }, 'Accessibility.enable');
  // Cross-origin child frames are their own targets; flatten puts them in this session.
  await d.sendCommand({ tabId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
}

/** One attach per tab, and everything that asks for it while it is in flight waits on the same promise. */
async function ensureAttached(tabId: number): Promise<void> {
  const why = paused.get(tabId);
  if (why !== undefined) throw new CdpPausedError(tabId, why);
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
    setTimeout(() => void detach(tabId), IDLE_DETACH_MS),
  );
}

/** Send a CDP command to a tab, attaching first if needed. */
export async function send<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
  await ensureAttached(tabId);
  touch(tabId);
  try {
    return (await debuggerApi().sendCommand({ tabId }, method, params)) as T;
  } catch (e) {
    // The session died underneath us (worker restart, tab crash): reattach once.
    if (!/not attached/i.test(errorMessage(e))) throw e;
    sessions.delete(tabId);
    await ensureAttached(tabId);
    return (await debuggerApi().sendCommand({ tabId }, method, params)) as T;
  }
}

/** A sender bound to one tab, for the outline reader and the perform path. */
export function sender(tabId: number): <T = unknown>(method: string, params?: object) => Promise<T> {
  return <T,>(method: string, params?: object) => send<T>(tabId, method, params);
}

export async function detach(tabId: number): Promise<void> {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  if (!sessions.delete(tabId)) return;
  await debuggerApi()
    .detach({ tabId })
    .catch(() => undefined);
  for (const l of detachListeners) l(tabId);
}

/** Called with the tab id whenever a session ends for any reason. */
const detachListeners: ((tabId: number) => void)[] = [];
export function onSessionEnd(listener: (tabId: number) => void): void {
  detachListeners.push(listener);
}

/** Whether this tab is reading through the DOM outline instead, and why. */
export function pauseReason(tabId: number): string | undefined {
  return paused.get(tabId);
}

export function isPaused(tabId: number): boolean {
  return paused.has(tabId);
}

/** The user brought the tab forward: a tab that fell back may try the debugger again. */
export function activated(tabId: number): void {
  paused.delete(tabId);
}

/** The tab is gone: no session, no timer, nothing remembered about it. */
export function closed(tabId: number): void {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  const had = sessions.delete(tabId);
  paused.delete(tabId);
  if (had) {
    void debuggerApi()
      .detach({ tabId })
      .catch(() => undefined);
  }
  for (const l of detachListeners) l(tabId);
}

/**
 * The tab went somewhere else. A URL carat may not read is a URL carat may not
 * hold a debugger over either, so the session goes with the navigation rather
 * than waiting out the idle timer with the banner up.
 */
export function navigated(tabId: number, url: string | undefined): void {
  if (attachable(url)) return;
  void detach(tabId);
}

/**
 * The session ended on its own: the user dismissed the banner, DevTools took
 * the target, or the tab crashed. The tab reads through the DOM outline until
 * it is activated again; attaching straight back would only raise the banner
 * the user just dismissed.
 */
function onDetached(tabId: number, reason: string): void {
  sessions.delete(tabId);
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  paused.set(tabId, DETACH_REASONS[reason] ?? reason);
  for (const l of detachListeners) l(tabId);
}

/** Chrome's own detach reasons, in the words the diag line prints. */
const DETACH_REASONS: Record<string, string> = {
  canceled_by_user: 'you dismissed the debugging banner',
  replaced_with_devtools: 'DevTools took the debugger',
  target_closed: 'the tab closed',
  rendered_process_gone: 'the page crashed',
};

function listen(d: DebuggerApi): void {
  if (listening) return;
  listening = true;
  d.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    onDetached(source.tabId, reason);
  });
}

/** Exported for the test that drives a detach without a real browser. */
export const __forTests = { onDetached };
