/** Messages between the content script and the service worker (one port per tab). */

export const PORT_NAME = "carat";

/** The text field the user is in, as the content script sees it. */
export interface FieldInfo {
  tag: "input" | "textarea";
  /** <input type>, or "textarea". */
  inputType: string;
  multiline: boolean;
  /** Best-effort accessible name; the worker prefers the AX tree's. */
  name: string;
  placeholder: string;
  maxLength: number | null;
  /** Text from the start of the field up to the caret. Empty when redacted. */
  typed: string;
  /** Text after the caret. Empty when redacted. */
  trailing: string;
  /** Password, payment, one-time-code...: never read, never completed. */
  redacted: boolean;
}

/** Sent once the user has been idle for IDLE_MS after interacting with the page. */
export interface IdleMessage {
  type: "idle";
  /**
   * The content script's activity counter when it went idle. Replies carry it
   * back, and are ignored if the user has done anything since.
   */
  reqId: number;
  url: string;
  title: string;
  /** The DOM changed (or a non-focused value changed) since the last idle message. */
  pageChanged: boolean;
  /** The last interaction before going idle, e.g. "input", "click", or "load" / "accept". */
  reason: string;
  field: FieldInfo | null;
}

/** Something the user just did, appended to the per-tab history. */
export interface LogMessage {
  type: "log";
  entry: string;
  url: string;
}

/** Tab pressed on a ready action suggestion (after arming, if irreversible). */
export interface AcceptMessage {
  type: "accept";
  reqId: number;
}

/** Esc pressed on an action suggestion. */
export interface DismissMessage {
  type: "dismiss";
  reqId: number;
}

/** What was on screen when the user left a page (tab switch or navigation), for reading memory. */
export interface SeenMessage {
  type: "seen";
  url: string;
  title: string;
  /** Visible text, sensitive values already masked. */
  text: string;
}

/** The user typed an instruction in the palette. */
export interface TaskMessage {
  type: "task";
  goal: string;
  url: string;
}

/** The user answered a question the task asked. */
export interface TaskAnswerMessage {
  type: "task-answer";
  answer: string;
}

/** Stop the running task (Stop button, Esc, or the user acting themselves). */
export interface TaskStopMessage {
  type: "task-stop";
}

export type ContentToWorker =
  | IdleMessage
  | LogMessage
  | AcceptMessage
  | DismissMessage
  | SeenMessage
  | TaskMessage
  | TaskAnswerMessage
  | TaskStopMessage;

// ---------------------------------------------------------------------------
// Worker → content

/**
 * Name of the event the worker dispatches (through CDP) on the element a
 * prediction targets, immediately before sending TargetMessage. The content
 * script's capture listener takes the element from it.
 */
export const TARGET_EVENT = "carat-target";

/**
 * reqId used by task steps. Suggestions are normally ignored once the user has
 * done anything since the request; a task's own steps are always current.
 */
export const TASK_REQ = -1;

export type ActionKind = "click" | "fill" | "select" | "submit" | "switch" | "open";

/** Kinds that act on the browser (tab strip, address bar) rather than the page. */
export const BROWSER_KINDS: ActionKind[] = ["switch", "open"];

/** The target is known (streamed early); the rest of the prediction is still coming. */
export interface TargetMessage {
  type: "target";
  reqId: number;
}

/** The full prediction for the element last sent with TargetMessage. */
export interface ActionMessage {
  type: "action";
  reqId: number;
  kind: ActionKind;
  label: string;
  value: string;
  irreversible: boolean;
  /** Acts on the browser, so there is nothing on the page to ring. */
  browser?: boolean;
}

/** No suggestion after all (model said none, or the target was invalid). */
export interface ClearMessage {
  type: "clear";
  reqId: number;
}

/** Outcome of an accepted action. */
export interface ResultMessage {
  type: "result";
  reqId: number;
  ok: boolean;
  reason?: string;
}

/** Ghost text for the focused field: the whole suggestion so far (it grows while streaming). */
export interface GhostMessage {
  type: "ghost";
  reqId: number;
  /** The field text the suggestion continues; the content script checks it still matches. */
  base: string;
  text: string;
  done: boolean;
}

/** Open the instruction box (the toolbar shortcut fires in the worker). */
export interface OpenPaletteMessage {
  type: "palette";
}

/**
 * Open the task panel for a task already running in this tab. Sent when a page
 * loads into a tab that has one: the old page's panel went with it.
 */
export interface TaskStartMessage {
  type: "task-start";
  goal: string;
}

export type TaskStepState = "running" | "done" | "failed" | "skipped" | "waiting";

/** One step of a running task, created or updated. */
export interface TaskStepMessage {
  type: "task-step";
  index: number;
  text: string;
  state: TaskStepState;
  /** The model's one-line reason for this step. */
  why?: string;
}

/** The task needs something from the user before it can go on. */
export interface TaskAskMessage {
  type: "task-ask";
  question: string;
}

/** The task is over: finished, stopped, or gave up. */
export interface TaskDoneMessage {
  type: "task-done";
  summary: string;
}

export type WorkerToContent =
  | TargetMessage
  | ActionMessage
  | ClearMessage
  | ResultMessage
  | GhostMessage
  | OpenPaletteMessage
  | TaskStartMessage
  | TaskStepMessage
  | TaskAskMessage
  | TaskDoneMessage;
