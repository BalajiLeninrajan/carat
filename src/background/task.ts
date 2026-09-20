/**
 * Tasks: an instruction typed in the palette, carried out step by step.
 *
 * The loop is plan-act-observe, not a plan written once up front: read the
 * page, decide one step, do it, wait for the page to settle, look again. That
 * is what survives dropdowns opening, validation errors and page loads.
 *
 * Safe steps run by themselves. Anything irreversible is offered the way an
 * ordinary suggestion is — ringed, with a chip — and waits for the user to tap
 * right Shift, so a task can never send, pay or delete on its own.
 */

import { TASK_REQ, type TaskStepMessage, type WorkerToContent } from "../shared/protocol.js";
import { isBlocked, loadSettings } from "../shared/settings.js";
import { announceTarget, click, pressEnter, select, setValue } from "./actuate.js";
import { browserContext, openOrSearch, switchToTab, waitForLoad } from "./browser.js";
import { getTree } from "./axmirror.js";
import { appendHistory, historyFor } from "./history.js";
import { streamResponse } from "./llm.js";
import { notesFor } from "./notes.js";
import { buildOutline, type Candidate } from "./outline.js";
import { buildTaskRequest } from "./prompts.js";

/** How long the page is given to react before it is read again. */
const SETTLE_MS = 450;
/** How long a confirmation waits for the user before moving on without it. */
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

/** Labels that mean "this cannot be undone": confirmed by hand, whatever the model says. */
const IRREVERSIBLE =
  /\b(send|submit|pay|purchase|buy|order|place|checkout|delete|remove|discard|publish|post|confirm|transfer|sign ?out|log ?out|unsubscribe|cancel (my )?(subscription|order|account))\b/i;

/** Where a task's panel goes: its own tab, and whichever tab the user is on. */
export type TaskSender = (tabId: number, msg: WorkerToContent) => void;

interface Task {
  goal: string;
  /** The tab the task is working in; it changes when the task switches tabs. */
  tabId: number;
  /** The site the task is currently on; it follows the page wherever it goes. */
  origin: string;
  startedAt: number;
  steps: string[];
  stopped: boolean;
  /** Set while waiting for the user to answer a question. */
  answer?: (answer: string) => void;
  /** Set while waiting for the user to confirm an irreversible step. */
  confirm?: (ok: boolean) => void;
  /** Step lines as shown, so the panel can be rebuilt after a page load. */
  lines: TaskStepMessage[];
  /** A question the user has not answered yet, for the same reason. */
  pendingQuestion?: string;
  post: (msg: WorkerToContent) => void;
}

const tasks = new Map<number, Task>();

export function hasTask(tabId: number): boolean {
  return tasks.has(tabId);
}

export function stopTask(tabId: number, reason = "Stopped."): void {
  const task = tasks.get(tabId);
  if (!task) return;
  task.stopped = true;
  task.confirm?.(false);
  tasks.delete(tabId);
  task.post({ type: "task-done", summary: reason });
  console.log(`[carat] task ended: ${reason}`);
}

export function answerTask(tabId: number, answer: string): void {
  const task = tasks.get(tabId);
  if (!task) return;
  task.pendingQuestion = undefined;
  task.answer?.(answer);
}

/**
 * Show the running task's panel in a tab: after a page load (the old page's
 * panel went with it), or when the user moves to a tab that has never seen it,
 * such as one the task opened.
 */
export function resumeTask(tabId: number, post: (msg: WorkerToContent) => void): void {
  // A task running anywhere is worth showing here: the user is watching this tab.
  const task = tasks.get(tabId) ?? [...tasks.values()][0];
  if (!task) return;
  post({ type: "task-start", goal: task.goal });
  for (const line of task.lines) post(line);
  if (task.pendingQuestion) post({ type: "task-ask", question: task.pendingQuestion });
}

/** The user tapped right Shift (accept) or Esc (dismiss) on a task's confirmation. */
export function confirmTask(tabId: number, ok: boolean): boolean {
  const task = tasks.get(tabId);
  if (!task?.confirm) return false;
  task.confirm(ok);
  return true;
}

export async function startTask(tabId: number, goal: string, url: string, sender: TaskSender): Promise<void> {
  stopTask(tabId, "Replaced by a new task.");
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {}
  const task: Task = {
    goal,
    tabId,
    origin,
    startedAt: Date.now(),
    steps: [],
    lines: [],
    stopped: false,
    // Always addressed to the tab the task is in *now*.
    post: (msg) => sender(task.tabId, msg),
  };
  tasks.set(tabId, task);
  console.log(`[carat] task: "${goal}" on ${url}`);
  try {
    await runTask(tabId, task);
  } catch (e) {
    console.error("[carat] task failed:", e);
    if (tasks.get(tabId) === task) {
      tasks.delete(tabId);
      task.post({ type: "task-done", summary: "Something went wrong; see the service worker console." });
    }
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Post a step line and remember it, so the panel can be rebuilt after a page load. */
function emit(task: Task, msg: TaskStepMessage): void {
  const at = task.lines.findIndex((l) => l.index === msg.index);
  if (at >= 0) task.lines[at] = msg;
  else task.lines.push(msg);
  task.post(msg);
}

/**
 * The tab once it has a URL and has stopped loading. Returns null only if it
 * really is gone, or it is still loading after several seconds.
 */
async function settledTab(tabId: number, tries = 3): Promise<chrome.tabs.Tab | null> {
  for (let i = 0; i < tries; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.url && tab.status !== "loading") return tab;
    await waitForLoad(tabId, 5_000);
  }
  const last = await chrome.tabs.get(tabId).catch(() => null);
  return last?.url ? last : null;
}

/** Did the page move on, or look different, after a step? */
async function pageChangedSince(tabId: number, before: string): Promise<boolean> {
  const tab = await settledTab(tabId);
  const url = tab?.url ?? "";
  if (!url) return true; // mid-navigation: something is certainly happening
  try {
    const { snapshot } = await getTree(tabId, url, true);
    const outline = buildOutline(snapshot.nodes, { mode: "action", url, focusedBackendId: snapshot.focusedBackendId });
    return `${url}|${outline.text.length}|${outline.candidates.length}` !== before;
  } catch {
    return true;
  }
}

/** "" for anything that is not an absolute http(s) URL (a search query, say). */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

interface Step {
  why: string;
  kind: string;
  target: number;
  value: string;
  label: string;
  irreversible: boolean;
  message: string;
}

type Confirmation = { ok: true } | { ok: false; feedback?: string };

/**
 * Wait on an irreversible step for the user to accept it (right Shift),
 * decline it (Esc), or type a correction, which counts as declining *and*
 * tells the task what to do instead.
 */
function askConfirmation(task: Task): Promise<Confirmation> {
  return new Promise<Confirmation>((resolve) => {
    const done = (result: Confirmation) => {
      clearTimeout(timer);
      task.confirm = undefined;
      task.answer = undefined;
      task.pendingQuestion = undefined;
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, feedback: "no answer for a while" }), CONFIRM_TIMEOUT_MS);
    task.confirm = (ok) => done(ok ? { ok: true } : { ok: false });
    task.answer = (feedback) => done({ ok: false, feedback });
  });
}

async function runTask(startTabId: number, task: Task): Promise<void> {
  let tabId = startTabId;
  const settings = await loadSettings();
  if (!settings.apiKey) {
    stopTask(tabId, "No API key: set one in Carat's options page.");
    return;
  }

  // Runs until it finishes, gets stuck, or the user stops it with Esc or Stop.
  for (let n = 0; ; n++) {
    if (task.stopped) return;

    // A step often navigates (submitting a form, following a link) and the tab
    // has no usable URL while that is in flight: wait it out rather than
    // mistaking it for a dead tab.
    const tab = await settledTab(tabId);
    if (!tab) {
      stopTask(tabId, "The page never finished loading.");
      return;
    }
    const url = tab.url ?? "";
    if (isBlocked(settings, url)) {
      stopTask(tabId, "This page is blocked in Carat's options.");
      return;
    }
    // A task goes wherever the work leads: a search, another site, a new tab.
    if (originOf(url) !== task.origin) {
      task.origin = originOf(url);
      console.log(`[carat] task followed the page to ${task.origin || url}`);
    }

    // Always read the page fresh: the last step probably changed it.
    const { snapshot } = await getTree(tabId, url, true);
    const outline = buildOutline(snapshot.nodes, {
      mode: "action",
      url,
      focusedBackendId: snapshot.focusedBackendId,
    });
    const [notes, history, browser] = await Promise.all([
      notesFor(url, settings),
      historyFor(tabId, url),
      browserContext(tabId),
    ]);
    if (task.stopped) return;

    const request = buildTaskRequest({
      settings,
      url,
      goal: task.goal,
      outline: outline.text,
      notes,
      history,
      steps: task.steps,
      browser: browser.text,
    });
    const started = performance.now();
    const result = await streamResponse(settings, request, () => {}, new AbortController().signal);
    if (task.stopped) return;

    let step: Step;
    try {
      step = JSON.parse(result.text);
    } catch {
      console.warn("[carat] task: unparseable step", result.text);
      stopTask(tabId, "The model's answer could not be read.");
      return;
    }
    console.log(
      `[carat] task step ${n + 1}: ${step.kind} [${step.target}] "${step.label}"${step.value ? ` = "${step.value}"` : ""}` +
        ` · ${step.why} · ${Math.round(performance.now() - started)}ms`,
    );

    if (step.kind === "done") {
      tasks.delete(tabId);
      task.post({ type: "task-done", summary: step.message || "Done." });
      return;
    }

    // A no-op: the page is still settling and there is nothing worth doing yet.
    // Working out this step already took a moment, so looking again is the wait.
    if (step.kind === "wait") {
      emit(task, { type: "task-step", index: n, text: "Wait and look again", state: "done", why: step.why });
      task.steps.push("waited and looked at the page again");
      await wait(SETTLE_MS);
      continue;
    }

    if (step.kind === "ask") {
      const question = step.message || "What should I do?";
      emit(task, { type: "task-step", index: n, text: question, state: "waiting", why: step.why });
      task.pendingQuestion = question;
      task.post({ type: "task-ask", question });
      const answer = await new Promise<string>((resolve) => (task.answer = resolve));
      task.answer = undefined;
      task.pendingQuestion = undefined;
      if (task.stopped) return;
      emit(task, { type: "task-step", index: n, text: `Asked: ${question} — you said "${answer}"`, state: "done" });
      task.steps.push(`asked "${question}"; the user answered "${answer}"`);
      continue;
    }

    // Tab strip and address bar: no element on the page is involved.
    if (step.kind === "switch" || step.kind === "open") {
      const tab = step.kind === "switch" ? browser.tabs[step.target - 1] : undefined;
      if (step.kind === "switch" && !tab) {
        emit(task, { type: "task-step", index: n, text: "That tab is gone", state: "failed" });
        task.steps.push(`tried to switch to [T${step.target}] but it is gone`);
        continue;
      }
      const text = step.kind === "switch" ? `Switch to "${tab!.title.slice(0, 50)}"` : `Open "${step.value}"`;

      emit(task, { type: "task-step", index: n, text, state: "running", why: step.why });

      const outcome = step.kind === "switch" ? await switchToTab(tab!) : await openOrSearch(tabId, step.value);
      if (!outcome.ok) {
        emit(task, { type: "task-step", index: n, text, state: "failed", why: outcome.reason });
        task.steps.push(`${text} — failed: ${outcome.reason}`);
        continue;
      }
      emit(task, { type: "task-step", index: n, text, state: "done", why: step.why });
      task.steps.push(`${text} — done`);

      // The task follows: a switch moves it to that tab, and any of these can
      // change which site it is on.
      if (step.kind === "switch") {
        tasks.delete(tabId);
        tabId = tab!.tabId;
        task.tabId = tabId;
        tasks.set(tabId, task);
      }
      await waitForLoad(tabId);
      const moved = await chrome.tabs.get(tabId).catch(() => null);
      if (moved?.url) task.origin = originOf(moved.url);
      continue;
    }

    const candidate: Candidate | undefined = outline.candidates[step.target - 1];
    if (!candidate) {
      emit(task, { type: "task-step", index: n, text: `Could not find ${step.label || "that control"}`, state: "failed" });
      task.steps.push(`tried ${step.kind} on [${step.target}] but it is not on the page`);
      continue;
    }

    const label = step.label.trim() || candidate.name || candidate.role;
    const text =
      step.kind === "click"
        ? `Click ${label}`
        : step.kind === "submit"
          ? `Press Enter in ${label}`
          : step.kind === "fill"
            ? `Fill ${label} with "${step.value}"`
            : `Set ${label} to "${step.value}"`;
    const irreversible = step.irreversible || IRREVERSIBLE.test(label) || IRREVERSIBLE.test(candidate.name);

    // Anything that cannot be undone is offered, not done.
    if (irreversible) {
      emit(task, { type: "task-step", index: n, text, state: "waiting", why: "needs your confirmation" });
      await announceTarget(tabId, candidate.backendNodeId).catch(() => {});
      task.post({ type: "target", reqId: TASK_REQ }); // rings it; the chip follows
      task.post({
        type: "action",
        reqId: TASK_REQ,
        kind: step.kind === "select" ? "select" : "click",
        label,
        value: step.value,
        irreversible: true,
      });
      const question = `${text}? Tap right Shift to confirm, or type what to change.`;
      task.pendingQuestion = question;
      task.post({ type: "task-ask", question });
      const answer = await askConfirmation(task);
      task.post({ type: "clear", reqId: TASK_REQ });
      if (task.stopped) return;
      if (!answer.ok) {
        // Declining is not the end of the task: the loop takes the correction
        // (or the bare refusal) as the newest thing it knows and carries on.
        emit(task, {
          type: "task-step",
          index: n,
          text,
          state: "skipped",
          why: answer.feedback ? `you said: ${answer.feedback}` : "you declined it",
        });
        task.steps.push(
          answer.feedback
            ? `did not do "${text}" — the user declined and said: "${answer.feedback}"`
            : `did not do "${text}" — the user declined it; do not offer it again unchanged`,
        );
        continue;
      }
    } else {
      emit(task, { type: "task-step", index: n, text, state: "running", why: step.why });
      await announceTarget(tabId, candidate.backendNodeId).catch(() => {});
      task.post({ type: "target", reqId: TASK_REQ });
    }

    // What the page looks like now, to tell afterwards whether the step did anything.
    const before = `${url}|${outline.text.length}|${outline.candidates.length}`;
    const outcome =
      step.kind === "click"
        ? await click(tabId, candidate.backendNodeId)
        : step.kind === "submit"
          ? await pressEnter(tabId, candidate.backendNodeId)
          : step.kind === "select"
            ? ((await select(tabId, candidate.backendNodeId, step.value)) ?? (await click(tabId, candidate.backendNodeId)))
            : await setValue(tabId, candidate.backendNodeId, step.value);
    task.post({ type: "clear", reqId: TASK_REQ });

    if (!outcome.ok) {
      emit(task, { type: "task-step", index: n, text, state: "failed", why: outcome.reason });
      task.steps.push(`${text} — failed: ${outcome.reason}`);
      await wait(SETTLE_MS);
      continue;
    }

    emit(task, { type: "task-step", index: n, text, state: "done", why: step.why });
    appendHistory(tabId, `${step.kind === "click" ? "clicked" : "filled"} ${candidate.role} "${candidate.name}" (Carat task)`, url);
    await wait(SETTLE_MS);

    // A step that leaves the page exactly as it was did not work. Saying so
    // stops the model doing it again and again (a search button that ignores
    // clicks, a disabled control that looks enabled).
    const changed = step.kind === "fill" ? true : await pageChangedSince(tabId, before);
    task.steps.push(`${text} — ${changed ? "done" : "done, but nothing on the page changed"}`);
    if (!changed) console.log(`[carat] task step ${n + 1} changed nothing`);
  }
}
