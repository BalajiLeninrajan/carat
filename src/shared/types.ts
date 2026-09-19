/** Message protocol between the content script and the service worker. */

export const PORT_NAME = "carat";

/**
 * Event the worker dispatches (through CDP) on the element a prediction
 * targets; the content script's capture listener receives it as event.target.
 */
export const TARGET_EVENT = "carat-target";

/** Everything the worker needs to know about the field being typed into. */
export interface FieldInfo {
  /** Accessibility role we believe the field has. */
  role: "textbox" | "searchbox" | "combobox";
  /** Accessible name: <label for>, aria-label, wrapping label, or name attr. */
  name: string;
  placeholder: string;
  multiline: boolean;
  maxLength: number | null;
  /** The <input type> (always "textarea" for textareas). */
  inputType: string;
  /** Text from the start of the field up to the caret. */
  typed: string;
  /** Characters already in the field after the caret (empty in v1). */
  trailing: string;
}

export interface SuggestMessage {
  type: "suggest";
  reqId: string;
  field: FieldInfo;
  url: string;
  title: string;
  /** DOM+ARIA outline, used when CDP is unavailable for this frame. */
  fallbackOutline: string;
  /** True when the content script sits in the top-level frame. */
  topFrame: boolean;
}

/** Ask for the user's most probable next action on the page. */
export interface PredictMessage {
  type: "predict";
  reqId: string;
  url: string;
  title: string;
  /** The text field the user is in, if any - its text is part of the context. */
  field: FieldInfo | null;
  /**
   * Numbered DOM+ARIA outline, used when CDP is unavailable. Its [n] indices
   * refer to candidates the content script keeps for this reqId.
   */
  fallbackOutline: string;
  topFrame: boolean;
}

export interface CancelMessage {
  type: "cancel";
  reqId: string;
}

export interface AcceptedMessage {
  type: "accepted";
  chars: number;
}

export interface RejectedMessage {
  type: "rejected";
}

export interface ActionAcceptedMessage {
  type: "action-accepted";
}

/** Something the user just did, for the per-tab history the predictor reads. */
export interface LogMessage {
  type: "log";
  entry: string;
}

export type ContentToWorker =
  | SuggestMessage
  | PredictMessage
  | CancelMessage
  | AcceptedMessage
  | RejectedMessage
  | ActionAcceptedMessage
  | LogMessage;

export interface DeltaMessage {
  type: "delta";
  reqId: string;
  text: string;
}

export interface DoneMessage {
  type: "done";
  reqId: string;
  stats: RequestStats;
}

export interface ErrorMessage {
  type: "error";
  reqId: string;
  message: string;
  /** Set when the failure is config, not transient — surfaces in the HUD. */
  fatal?: boolean;
}

export interface StateMessage {
  type: "state";
  enabled: boolean;
  predictActions: boolean;
  actionConfidence: number;
  model: string;
  axSource: AxSource;
  session: SessionStats;
}

export type ActionKind = "click" | "focus" | "select";

export interface PredictedAction {
  kind: ActionKind;
  /** Index into the numbered outline the model saw. */
  target: number;
  /** Option text for select; text to pre-fill for focus. */
  value: string;
  /** Short label for the chip: "Send reply", "Status: Resolved". */
  label: string;
  confidence: number;
  /** Sends, submits, pays, deletes... - needs a second Tab to confirm. */
  irreversible: boolean;
}

export interface ActionMessage {
  type: "action";
  reqId: string;
  /** null when the model had nothing confident to offer. */
  action: PredictedAction | null;
  /**
   * How the content script finds the element: "event" means the worker
   * dispatched a carat-target event on it through CDP; "index" means the
   * target is an index into the content script's own fallback candidates.
   */
  resolve: "event" | "index";
  stats: RequestStats;
}

export type WorkerToContent =
  | DeltaMessage
  | DoneMessage
  | ErrorMessage
  | StateMessage
  | ActionMessage;

export type AxSource = "cdp" | "fallback" | "none";

export interface RequestStats {
  /** ms from request start to first streamed character. */
  ttft: number;
  /** ms from request start to stream end. */
  total: number;
  axSource: AxSource;
  /** Characters of page outline sent. */
  outlineChars: number;
  cached: boolean;
  model: string;
  /** Prompt text actually sent, for the HUD's inspector. */
  prompt: string;
}

export interface SessionStats {
  requests: number;
  accepted: number;
  /** Suggestions served without a network round trip (prefix reuse / cache). */
  freeHits: number;
  medianTtft: number;
  predictions: number;
  actionsAccepted: number;
}

export interface Settings {
  apiKey: string;
  model: string;
  /** Which OpenAI surface to call. */
  api: "responses" | "chat";
  baseUrl: string;
  enabled: boolean;
  debounceMs: number;
  maxOutputTokens: number;
  /** Hostnames Carat must never read or suggest on. */
  blocklist: string[];
  useAccessibilityTree: boolean;
  /** Predict the next click/focus/select, not just the next words. */
  predictActions: boolean;
  /** Below this, an action prediction is not shown at all. */
  actionConfidence: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "gpt-5.6-luna",
  api: "responses",
  baseUrl: "https://api.openai.com/v1",
  enabled: true,
  debounceMs: 280,
  maxOutputTokens: 48,
  blocklist: [],
  useAccessibilityTree: true,
  predictActions: true,
  actionConfidence: 0.55,
};

/**
 * Labels for actions that cannot be taken back. Matching one means the first
 * Tab only arms the action and a second Tab runs it. Deliberately broad: a
 * false positive costs one keypress, a false negative sends an email.
 */
export const IRREVERSIBLE =
  /\b(send|submit|post|publish|pay|purchase|buy|order|checkout|check out|place|transfer|delete|remove|discard|archive|unsubscribe|cancel|confirm|sign|approve|merge|deploy)\b/i;
