/** Messages between the content script and the service worker (one port per tab). */

export const PORT_NAME = "caret";

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
  /** The page continues past the bottom of the viewport, so "scroll" is a step the model may take. */
  moreBelow?: boolean;
  /** What the user has highlighted on the page, trimmed and capped. Empty when nothing is selected. */
  selection?: string;
  /**
   * Ours: the page is showing a password field. The decision loop ignores it;
   * it is the one place the worker learns a tab is on a login form, so the
   * system clipboard is never read while that tab is in front.
   */
  password?: boolean;
}

/** Something the user just did, appended to the per-tab history. */
export interface LogMessage {
  type: "log";
  entry: string;
  url: string;
}

/** Caret's key tapped on a ready action suggestion (after arming, if irreversible). */
export interface AcceptMessage {
  type: "accept";
  reqId: number;
}

/** Esc pressed on an action suggestion. */
export interface DismissMessage {
  type: "dismiss";
  reqId: number;
}

/** The user took a different trusted action while a suggestion was visible. */
export interface AlternativeMessage {
  type: "alternative";
  reqId: number;
  actual: string;
}

/** What was on screen when the user left a page (tab switch or navigation), for reading memory. */
export interface SeenMessage {
  type: "seen";
  url: string;
  title: string;
  /** Visible text, sensitive values already masked. */
  text: string;
}

/**
 * Ours: text the user just copied or cut on the page. It becomes a note as it
 * stands, with no model call in between: what they copied is already the fact.
 */
export interface CopiedMessage {
  type: "copied";
  url: string;
  title: string;
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

/** Stop the running task: the Stop button, Esc, or the user taking over. */
export interface TaskStopMessage {
  type: "task-stop";
}

export type ContentToWorker =
  | IdleMessage
  | LogMessage
  | AcceptMessage
  | DismissMessage
  | AlternativeMessage
  | SeenMessage
  | CopiedMessage
  | TaskMessage
  | TaskAnswerMessage
  | TaskStopMessage;

/**
 * The reqId a task's own steps carry. An ordinary suggestion is ignored once
 * the user has done anything since it was asked for; a task's steps are always
 * current, because the task is the one doing things.
 */
export const TASK_REQ = -1;

// ---------------------------------------------------------------------------
// Worker → content

/**
 * Name of the event the worker dispatches (through CDP) on the element a
 * prediction targets, immediately before sending TargetMessage. The content
 * script's capture listener takes the element from it.
 */
export const TARGET_EVENT = "caret-target";

export type ActionKind = "click" | "fill" | "select" | "submit" | "switch" | "open" | "scroll";

/** Kinds that act on the browser (tab strip, address bar) rather than the page. */
export const BROWSER_KINDS: ActionKind[] = ["switch", "open"];

/**
 * Kinds with no control of their own to ring. The browser kinds, plus scroll,
 * which is about the viewport rather than anything in it. The content script
 * carries scroll out itself, so it never reaches the worker's actuator.
 */
export const UNTARGETED_KINDS: ActionKind[] = [...BROWSER_KINDS, "scroll"];

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

/** Open the instruction box (Ctrl+Shift+K reaches the worker, not the page). */
export interface OpenPaletteMessage {
  type: "palette";
}

/**
 * Show the task panel for a task already running in this tab: after a page
 * load took the old panel with it, or when the user moves to a tab the task
 * opened.
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
