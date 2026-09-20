import { defineContentScript } from 'wxt/utils/define-content-script';
import { createChip, type ChipKind } from '../src/chip';
import { watchTap } from '../src/chip/accept-key';
import { startDebug } from '../src/debug';
import { Ghost } from '../src/engine/content/ghost';
import { Ring } from '../src/engine/content/ring';
import {
  PORT_NAME,
  TARGET_EVENT,
  type ActionKind,
  type ContentToWorker,
  type FieldInfo,
  type WorkerToContent,
} from '../src/engine/shared/protocol';
import { isSensitiveField, looksSecret, maskSensitive } from '../src/engine/shared/redact';
import { onMessage, safeSendMessage } from '../src/messaging';
import { createQuiet } from '../src/quiet';
import { caratScrolling, hasMoreBelow, scrollPageDown } from '../src/scroll';
import { createStatusLine, PAUSED_NOTICE } from '../src/status';

/** How long the user must be still, after interacting, before Carat looks at the page. */
const IDLE_MS = 500;
/** Shorter pause while typing: ghost text has to feel instant, and it uses the cached tree. */
const TYPING_IDLE_MS = 250;
/** How often the status pill re-asks the worker what it should say. */
const STATUS_POLL_MS = 5000;
/** How long a paused tab shows the pill it would otherwise be keeping hidden. */
const PAUSE_NOTICE_MS = 4000;
/** A highlight settles before it counts as one: dragging a selection fires all the way. */
const SELECTION_MS = 300;
/** How still the page has to be, after the user scrolls it, before Carat asks about what is now on screen. */
const SCROLL_SETTLE_MS = 600;
/** What the model is told the user highlighted, at most. */
const MAX_SELECTION = 300;
/** The chip, the ring, the status pill and the debug panel each hang off an attribute of their own. */
const CARAT_SURFACES = '[data-carat-chip], [data-carat-ring], [data-carat-status], [data-carat-debug], carat-ring, carat-ghost';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main(ctx) {
    // -----------------------------------------------------------------------
    // Port to the worker. It drops whenever the service worker is recycled, so
    // it is re-opened on a timer as well as on demand.

    let port: chrome.runtime.Port | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function connect(): chrome.runtime.Port | null {
      if (port) return port;
      // After the extension is reloaded this context is orphaned: chrome.runtime.id is gone.
      if (!chrome.runtime?.id || !ctx.isValid) return null;
      try {
        port = chrome.runtime.connect({ name: PORT_NAME });
      } catch {
        return null;
      }
      port.onMessage.addListener(onWorkerMessage);
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        port = null;
        clearTimeout(reconnectTimer);
        if (document.visibilityState === 'visible') reconnectTimer = setTimeout(connect, 1000);
      });
      return port;
    }

    function post(msg: ContentToWorker): void {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const p = connect();
          if (!p) return;
          p.postMessage(msg);
          return;
        } catch {
          // Disconnected between connect() and the send: drop it and retry once.
          port = null;
        }
      }
    }

    addEventListener('pagehide', () => {
      sendSeen();
      clearTimeout(reconnectTimer);
      port?.disconnect();
      port = null;
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') connect();
    });

    // -----------------------------------------------------------------------
    // Text fields

    type TextField = HTMLInputElement | HTMLTextAreaElement;
    const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

    function asTextField(el: Element | null): TextField | null {
      if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
      if (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) {
        return el.readOnly || el.disabled ? null : el;
      }
      return null;
    }

    /** document.activeElement, looking through open shadow roots. */
    function deepActive(): Element | null {
      let el: Element | null = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      return el;
    }

    function clip(s: string, max: number): string {
      const one = s.replace(/\s+/g, ' ').trim();
      return one.length > max ? `${one.slice(0, max - 1)}…` : one;
    }

    /** Rough accessible name. The worker uses the AX tree's real one where it can. */
    function accessibleName(el: Element): string {
      const aria = el.getAttribute('aria-label');
      if (aria) return clip(aria, 60);
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        if (text.trim()) return clip(text, 60);
      }
      const labels = (el as TextField).labels;
      if (labels?.length) return clip(labels[0]?.textContent ?? '', 60);
      if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return clip(el.value, 60);
      const text = (el as HTMLElement).innerText;
      if (text?.trim()) return clip(text, 60);
      const alt = el.querySelector('img[alt]')?.getAttribute('alt');
      if (alt) return clip(alt, 60);
      return clip(el.getAttribute('title') ?? el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '', 60);
    }

    function fieldInfo(el: TextField): FieldInfo {
      const redacted = isSensitiveField(el);
      // Some input types (email, number) do not expose a selection; treat the caret as at the end.
      let caret = el.value.length;
      try {
        if (el.selectionStart != null) caret = el.selectionStart;
      } catch {
        // no selection API on this input type
      }
      return {
        tag: el instanceof HTMLTextAreaElement ? 'textarea' : 'input',
        inputType: el instanceof HTMLTextAreaElement ? 'textarea' : el.type || 'text',
        multiline: el instanceof HTMLTextAreaElement,
        name: accessibleName(el),
        placeholder: el.placeholder ?? '',
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        typed: redacted ? '' : el.value.slice(0, caret),
        trailing: redacted ? '' : el.value.slice(caret),
        redacted,
      };
    }

    // -----------------------------------------------------------------------
    // Interaction history

    const CLICKABLE =
      'a[href], button, summary, select, input:not([type=hidden]), textarea, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=checkbox], [role=radio], [role=switch], [role=treeitem], [onclick]';

    function roleName(el: Element): string {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      if (el instanceof HTMLAnchorElement) return 'link';
      if (el instanceof HTMLButtonElement || el.tagName === 'SUMMARY') return 'button';
      if (el instanceof HTMLSelectElement) return 'combobox';
      if (el instanceof HTMLTextAreaElement) return 'textbox';
      if (el instanceof HTMLInputElement) {
        if (['submit', 'button', 'reset', 'image'].includes(el.type)) return 'button';
        if (el.type === 'checkbox' || el.type === 'radio') return el.type;
        return el.type === 'search' ? 'searchbox' : 'textbox';
      }
      return el.tagName.toLowerCase();
    }

    function log(entry: string): void {
      markAlternative(entry);
      post({ type: 'log', entry, url: location.href });
    }

    function describe(el: Element): string {
      const name = accessibleName(el);
      return name ? `${roleName(el)} "${name}"` : roleName(el);
    }

    /** Value of the focused field when it gained focus, to log "typed into" on blur. */
    let focusValue: { el: TextField; value: string } | null = null;

    document.addEventListener(
      'click',
      (e) => {
        if (!e.isTrusted) return;
        const target = (e.composedPath()[0] as Element | undefined)?.closest?.(CLICKABLE);
        if (!target || asTextField(target) || target instanceof HTMLSelectElement) return;
        if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) return;
        if (target instanceof HTMLLabelElement && target.control) return;
        log(`clicked ${describe(target)}`);
      },
      true,
    );

    document.addEventListener(
      'change',
      (e) => {
        const el = e.target;
        if (el instanceof HTMLSelectElement) {
          log(`selected "${clip(el.selectedOptions[0]?.text ?? el.value, 60)}" in combobox "${accessibleName(el)}"`);
        } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          log(`${el.checked ? 'checked' : 'unchecked'} ${el.type} "${accessibleName(el)}"`);
        }
      },
      true,
    );

    document.addEventListener(
      'focusin',
      () => {
        const f = asTextField(deepActive());
        focusValue = f ? { el: f, value: f.value } : null;
      },
      true,
    );

    document.addEventListener(
      'focusout',
      (e) => {
        const el = e.target as Element;
        if (ghostState?.el === el) clearGhost();
        if (!focusValue || focusValue.el !== el) return;
        const { el: f, value: before } = focusValue;
        focusValue = null;
        if (f.value === '' || f.value === before) return;
        if (isSensitiveField(f)) log(`typed into ${describe(f)} (redacted)`);
        else log(`typed into ${describe(f)}: "${clip(f.value, 60)}"`);
      },
      true,
    );

    // -----------------------------------------------------------------------
    // Action suggestions: their ring while the answer streams, our chip once
    // it has landed.

    // One ring, shared: the engine puts it on the target the moment one
    // streams in, and the chip keeps the same ring there until the offer goes.
    const ring = new Ring();
    const chip = createChip(document, ring);
    const status = createStatusLine(document);
    const debug = startDebug(ctx, document);
    // Shift+Tab on any chip: a chord, never carat's own tap, and a minute
    // with nothing asked and nothing offered.
    const quiet = createQuiet((left) => status.setQuiet(left));

    interface Suggestion {
      reqId: number;
      el: Element | null;
      kind: ActionKind;
      value: string;
      label: string;
    }
    let suggestion: Suggestion | null = null;

    /** The element the worker last dispatched TARGET_EVENT on (always just before a "target" message). */
    let lastTarget: Element | null = null;
    document.addEventListener(TARGET_EVENT, (e) => (lastTarget = e.composedPath()[0] as Element), true);

    function clearSuggestion(): void {
      suggestion = null;
      ring.hide();
      chip.hide();
    }

    function markAlternative(actual: string): void {
      const s = suggestion;
      if (!s) return;
      suggestion = null;
      ring.hide();
      chip.hide();
      post({ type: 'alternative', reqId: s.reqId, actual });
    }

    /** Their kinds, as the chip's own smaller vocabulary of exits and marks. */
    function chipKind(kind: ActionKind): ChipKind {
      switch (kind) {
        case 'fill':
        case 'click':
        case 'select':
        case 'scroll':
        case 'open':
        case 'switch':
          return kind;
        case 'submit':
          return 'click';
        default:
          return 'none';
      }
    }

    function labelFor(kind: ActionKind, label: string, value: string): string {
      if (kind === 'switch') return `Switch to ${label}`;
      if (kind === 'open') return `Open ${label || value}`;
      if (kind === 'scroll') return label || 'Read on';
      if ((kind === 'fill' || kind === 'select') && value) return `${label}: ${clip(value, 60)}`;
      return label;
    }

    function showAction(msg: Extract<WorkerToContent, { type: 'action' }>): void {
      const label = labelFor(msg.kind, msg.label, msg.value);
      const common = {
        label,
        kind: chipKind(msg.kind),
        irreversible: msg.irreversible,
        onAccept: () => acceptAction(),
        onDismiss: (reason: string) => {
          const s = suggestion;
          suggestion = null;
          ring.hide();
          if (reason === 'escape' && s) post({ type: 'dismiss', reqId: s.reqId });
          // Shift+Tab is not about this offer, it is about the next minute of them.
          if (reason === 'snoozed') startQuiet();
        },
      };
      if (msg.browser || !suggestion?.el) chip.showBanner(common);
      else chip.show({ ...common, target: suggestion.el });
    }

    function acceptAction(): void {
      const s = suggestion;
      if (!s) return;
      suggestion = null;
      ring.hide();
      // One screen down is the page's own business; nothing goes to the worker.
      if (s.kind === 'scroll') {
        void scrollPageDown(window).then(() => {
          log('scrolled one screen');
          schedule('accept');
        });
        return;
      }
      if (s.kind === 'fill' && s.el && fillLocally(s)) return;
      post({ type: 'accept', reqId: s.reqId });
    }

    // -----------------------------------------------------------------------
    // Ghost text

    const ghost = new Ghost();

    interface GhostState {
      reqId: number;
      el: TextField;
      /** Field text the suggestion continues. */
      base: string;
      /** The whole suggestion so far (grows while streaming). */
      text: string;
      /** How much of `text` the user has since typed themselves. */
      consumed: number;
      done: boolean;
    }
    let ghostState: GhostState | null = null;

    function clearGhost(): void {
      ghostState = null;
      ghost.hide();
    }

    function remaining(g: GhostState): string {
      return g.text.slice(g.consumed);
    }

    function caretAtEnd(f: TextField): boolean {
      try {
        if (f.selectionStart == null) return true;
        return f.selectionStart === f.value.length && f.selectionEnd === f.value.length;
      } catch {
        return true;
      }
    }

    function renderGhost(): void {
      const g = ghostState;
      if (!g) return ghost.hide();
      const f = g.el;
      const intact = f.value === g.base + g.text.slice(0, g.consumed);
      if (asTextField(deepActive()) !== f || !caretAtEnd(f) || !intact || !remaining(g)) return ghost.hide();
      ghost.show(f, remaining(g));
    }

    /**
     * The user typed into the field while a suggestion was showing. If they
     * typed exactly what it suggested, advance through it locally: no new
     * request. Returns false when the suggestion no longer applies.
     */
    function advanceGhost(): boolean {
      const g = ghostState;
      if (!g) return false;
      const f = g.el;
      const full = g.base + g.text;
      const typedAlong =
        f.value.length > g.base.length + g.consumed && f.value.startsWith(g.base) && full.startsWith(f.value);
      if (!typedAlong) return false;
      g.consumed = f.value.length - g.base.length;
      if (g.done && !remaining(g)) return false;
      renderGhost();
      return true;
    }

    /** Insert text at the caret the way typing would, so frameworks and undo see it. */
    function insertText(f: TextField, text: string): void {
      f.focus();
      if (document.execCommand('insertText', false, text)) return;
      const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
      setter.call(f, f.value + text);
      f.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      onFieldInput();
    }

    function acceptGhost(g: GhostState, wordOnly: boolean): void {
      const rest = remaining(g);
      insertText(g.el, wordOnly ? (/^\s*\S+/.exec(rest)?.[0] ?? rest) : rest);
    }

    function ghostVisible(): GhostState | null {
      const g = ghostState;
      return g && remaining(g) && ghost.element?.style.display !== 'none' ? g : null;
    }

    /**
     * Ghost text has first claim on carat's key. These listeners are bound
     * before any chip exists, and window capture runs in the order listeners
     * were added, so a field with grey text in it answers the tap itself and
     * the chip never sees it.
     */
    const ghostTap = watchTap();
    window.addEventListener(
      'keydown',
      (e) => {
        if (!e.isTrusted) return;
        // The latch is kept whether or not there is grey text to take: what
        // matters on the way down is only that nothing else was pressed.
        if (ghostTap.keydown(e)) return;
        if (e.isComposing) return;
        const g = ghostVisible();
        if (!g) return;
        const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
        if (e.key === 'ArrowRight' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          acceptGhost(g, true);
          return;
        }
        if (e.key === 'Escape' && bare) {
          e.preventDefault();
          e.stopImmediatePropagation();
          clearGhost();
        }
      },
      true,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (!e.isTrusted || !ghostTap.keyup(e)) return;
        const g = ghostVisible();
        if (!g) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        acceptGhost(g, false);
      },
      true,
    );
    window.addEventListener('pointerdown', () => ghostTap.cancel(), true);

    // -----------------------------------------------------------------------
    // Filling in the page

    const DATE_INPUT_TYPES = new Set(['date', 'datetime-local', 'month', 'time', 'week']);

    /**
     * The model writes dates the way people do ("March 3", "3/14/2027 5pm").
     * Convert to what <input type=date|datetime-local|month|time> wants. A date
     * with no year means its next occurrence.
     */
    function toInputValue(type: string, text: string): string | null {
      if (type === 'time') {
        const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
        if (!m) return null;
        let h = Number(m[1]) % 24;
        if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
        if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0;
        return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`;
      }
      if (/^\d{4}-\d{2}(-\d{2})?(T\d{2}:\d{2})?$/.test(text)) return text;
      const d = new Date(text);
      if (Number.isNaN(d.getTime())) return null;
      if (!/\b\d{4}\b/.test(text)) {
        const today = new Date();
        d.setFullYear(today.getFullYear());
        if (d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) d.setFullYear(today.getFullYear() + 1);
      }
      const pad = (n: number): string => String(n).padStart(2, '0');
      const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (type === 'date') return ymd;
      if (type === 'month') return ymd.slice(0, 7);
      if (type === 'datetime-local') return `${ymd}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return null; // week: rare enough to leave to the user
    }

    /**
     * Rich-text editors cannot show ghost text, so the value, already visible
     * on the chip, goes straight in at the end of the editor.
     */
    function fillEditable(s: Suggestion): boolean {
      const el = s.el as HTMLElement | null;
      const editable = el?.isContentEditable
        ? el
        : (el?.querySelector?.('[contenteditable]:not([contenteditable=false])') as HTMLElement | null);
      if (!editable?.isContentEditable) return false;
      editable.focus();
      const sel = getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (s.value) document.execCommand('insertText', false, s.value);
      log(`filled ${describe(editable)}`);
      schedule('accept');
      return true;
    }

    /** Date/time inputs cannot show ghost text either: set the value directly. */
    function fillDateInput(s: Suggestion): boolean {
      const el = s.el;
      if (!(el instanceof HTMLInputElement) || !DATE_INPUT_TYPES.has(el.type)) return false;
      el.focus();
      const value = toInputValue(el.type, s.value);
      if (value) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        log(`set ${describe(el)} to ${value}`);
      } else {
        log(`jumped to ${describe(el)}`);
      }
      schedule('accept');
      return true;
    }

    /**
     * "fill": jump to the field and offer the value as ghost text, so accepting
     * it is one more tap (and the user sees it before it goes in). Returns false
     * for targets that are not plain text fields; the worker focuses those.
     */
    function fillLocally(s: Suggestion): boolean {
      const f = asTextField(s.el);
      if (!f) return fillDateInput(s) || fillEditable(s);
      f.focus();
      try {
        f.setSelectionRange(f.value.length, f.value.length);
      } catch {
        // no selection API on this input type
      }
      log(`jumped to ${describe(f)}`);
      const current = f.value;
      if (current && !s.value.toLowerCase().startsWith(current.toLowerCase())) return true;
      const text = s.value.slice(current.length);
      if (!text) return true;
      ghostState = { reqId: activity, el: f, base: current, text, consumed: 0, done: true };
      renderGhost();
      return true;
    }

    // -----------------------------------------------------------------------
    // The worker's side of the conversation

    function onWorkerMessage(msg: WorkerToContent): void {
      if (msg.type === 'result') {
        if (msg.ok) {
          // Chain: look for the next step once the page settles.
          schedule('accept');
        } else {
          chip.showBanner({
            label: msg.reason ?? 'Could not do that.',
            onAccept: () => chip.hide(),
            onDismiss: () => undefined,
          });
        }
        return;
      }
      // Replies to an older idle: the user has moved on since.
      if (msg.reqId !== activity) return;
      switch (msg.type) {
        case 'target':
          if (!lastTarget?.isConnected) return;
          suggestion = { reqId: msg.reqId, el: lastTarget, kind: 'click', value: '', label: '' };
          ring.show(lastTarget);
          debug.event({ name: 'target ringed' });
          break;
        case 'action':
          if (msg.browser) suggestion = { reqId: msg.reqId, el: null, kind: msg.kind, value: msg.value, label: msg.label };
          else if (!suggestion || suggestion.reqId !== msg.reqId) return;
          else Object.assign(suggestion, { kind: msg.kind, value: msg.value, label: msg.label });
          showAction(msg);
          debug.event({ name: 'chip up', detail: `${msg.kind} "${msg.label}"` });
          break;
        case 'clear':
          clearSuggestion();
          break;
        case 'ghost': {
          if (ghostState?.reqId === msg.reqId && ghostState.base === msg.base) {
            ghostState.text = msg.text;
            ghostState.done = msg.done;
            if (!advanceGhost()) renderGhost();
            break;
          }
          const f = asTextField(deepActive());
          if (!f || f.value !== msg.base) return;
          if (!msg.text) return clearGhost();
          ghostState = { reqId: msg.reqId, el: f, base: msg.base, text: msg.text, consumed: 0, done: msg.done };
          renderGhost();
          break;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Idle detection

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastReason = '';
    /** Bumped on every user interaction; idle messages carry it as their reqId. */
    let activity = 0;
    /** DOM mutated, or a non-focused control changed, since the last idle message. */
    let pageChanged = true;

    function schedule(reason: string): void {
      // A quiet minute is a minute of not asking, so nothing is even queued.
      if (quiet.active) return;
      lastReason = reason;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, reason === 'input' ? TYPING_IDLE_MS : IDLE_MS);
    }

    function startQuiet(): void {
      clearTimeout(idleTimer);
      quiet.start();
      debug.event({ name: 'quiet', detail: 'Shift+Tab: a minute without offers' });
    }

    const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

    /** Typing in a field: ride along an existing suggestion, or start a new request. */
    function onFieldInput(): void {
      if (advanceGhost()) return;
      clearGhost();
      activity++;
      if (suggestion) markAlternative(`typed into ${describe(deepActive() ?? document.body)}`);
      schedule('input');
    }

    /**
     * Any interaction makes a showing suggestion stale, so the chip goes with
     * it. The chip has its own rules for a pointer, a scroll or a focus move;
     * this covers the keyboard and everything that reaches the page first.
     */
    function onActivity(e: Event): void {
      if (!e.isTrusted) return;
      if (e.type === 'keydown') {
        const k = e as KeyboardEvent;
        if (MODIFIER_KEYS.has(k.key)) return;
        // A character key: the input event that follows decides (it may just be
        // typing along the ghost text, which must not cancel it).
        if (ghostState && k.key.length === 1 && !k.ctrlKey && !k.metaKey && !k.altKey) return;
      }
      if ((e as InputEvent).isComposing) {
        clearGhost();
        clearTimeout(idleTimer);
        return;
      }
      if (e.type === 'input' && asTextField(e.target as Element)) return onFieldInput();
      clearGhost();
      activity++;
      if (suggestion) markAlternative(`${e.type} on page`);
      // Typing in the focused field is not a page change: its value is sent with
      // the idle message. Anything else that changes values is.
      if (e.type === 'change') pageChanged = true;
      schedule(e.type);
    }

    /**
     * What the user has highlighted: evidence in its own right, and often the
     * whole of what the next step is about. Never read out of a field carat is
     * not allowed to read, and never out of carat's own surfaces.
     */
    function selectedText(): string {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
      const anchor = sel.anchorNode;
      const host = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
      if (host?.closest(CARAT_SURFACES)) return '';
      const field = asTextField(host?.closest('input, textarea') ?? null);
      if (field && isSensitiveField(field)) return '';
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      return maskSensitive(text).slice(0, MAX_SELECTION);
    }

    /** The last highlight sent, so the same one is not re-asked on every idle. */
    let lastSelection = '';
    let selectionTimer: ReturnType<typeof setTimeout> | undefined;

    document.addEventListener('selectionchange', () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        const text = selectedText();
        if (text === lastSelection) return;
        lastSelection = text;
        // A highlight is itself a trigger; clearing one is not.
        if (!text) return;
        activity++;
        clearSuggestion();
        schedule('selection');
      }, SELECTION_MS);
    });

    function onIdle(): void {
      if (document.visibilityState !== 'visible' || quiet.active) return;
      const f = asTextField(deepActive());
      const selection = selectedText();
      lastSelection = selection;
      post({
        type: 'idle',
        reqId: activity,
        url: location.href,
        title: document.title,
        pageChanged,
        reason: lastReason,
        field: f ? fieldInfo(f) : null,
        moreBelow: hasMoreBelow(window, document),
        selection,
        password: hasPasswordField(),
      });
      pageChanged = false;
    }

    for (const type of ['keydown', 'input', 'pointerdown', 'click', 'change', 'focusin']) {
      document.addEventListener(type, onActivity, true);
    }

    /**
     * Scrolling is not on that list. It is not an answer to the offer, so the
     * chip stays where it is and comes back when its control does. It is a
     * new part of the page to look at, though, so once the scrolling stops
     * the question goes out again and whatever lands replaces what is up.
     *
     * On its own timer rather than the activity one: a page that scrolls
     * itself must not be able to hold the idle timer open forever. Carat's
     * own scrolling is excluded, because it asks on its own when it lands.
     */
    let scrollSettle: ReturnType<typeof setTimeout> | undefined;
    document.addEventListener(
      'scroll',
      () => {
        if (caratScrolling()) return;
        clearTimeout(scrollSettle);
        scrollSettle = setTimeout(() => schedule('scroll'), SCROLL_SETTLE_MS);
      },
      { capture: true, passive: true },
    );

    /**
     * React and friends rewrite the focused input's value attribute on every
     * keystroke; that is typing, not a page change. Carat's own surfaces are
     * not either. This is the signal the worker's tree cache invalidates on.
     */
    new MutationObserver((records) => {
      if (pageChanged) return;
      const focused = deepActive();
      const ours = [ring.element, ghost.element].filter((el): el is HTMLElement => !!el);
      const isOurs = (r: MutationRecord): boolean =>
        ours.some((el) => r.target === el || [...r.addedNodes].includes(el)) ||
        (r.target instanceof Element && caratSurface(r.target)) ||
        [...r.addedNodes].some((n) => n instanceof Element && caratSurface(n));
      if (records.some((r) => r.target !== focused && !isOurs(r))) pageChanged = true;
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

    function caratSurface(el: Element): boolean {
      return el.matches(CARAT_SURFACES);
    }

    // -----------------------------------------------------------------------
    // Reading memory: when the user leaves the page, send what was on screen.

    const MIN_DWELL_MS = 3000;
    const MAX_SEEN_CHARS = 6000;
    let visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;

    /** Text currently in the viewport, in document order, one line per element. */
    function visibleText(): string {
      const lines: string[] = [];
      let size = 0;
      let lastParent: Element | null = null;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
          const p = n.parentElement;
          if (!p || p.closest('script, style, noscript, template, textarea, [aria-hidden=true]')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const range = document.createRange();
      for (let n = walker.nextNode(); n && size < MAX_SEEN_CHARS; n = walker.nextNode()) {
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
          continue;
        }
        const text = n.nodeValue!.replace(/\s+/g, ' ').trim();
        const parent = n.parentElement;
        if (parent === lastParent && lines.length) lines[lines.length - 1] += ` ${text}`;
        else lines.push(text);
        lastParent = parent;
        size += text.length + 1;
      }
      return maskSensitive(lines.join('\n')).slice(0, MAX_SEEN_CHARS);
    }

    function hasPasswordField(): boolean {
      return document.querySelector('input[type=password]') !== null;
    }

    function sendSeen(): void {
      if (!visibleSince || Date.now() - visibleSince < MIN_DWELL_MS) return;
      visibleSince = 0;
      // A page asking for a password is not one to remember.
      if (hasPasswordField()) return;
      const text = visibleText();
      if (text.length >= 40) post({ type: 'seen', url: location.href, title: document.title, text });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') sendSeen();
      else visibleSince = Date.now();
    });

    // -----------------------------------------------------------------------
    // Ours: what the user copies here. No permission is needed for this half —
    // the page fires `copy` and `cut` at the content script already — so it is
    // always on, and the text goes to the worker as it stands.

    /** Below this a copy says nothing; a stray Ctrl+C on one character is not a fact. */
    const MIN_COPY_CHARS = 2;
    const MAX_COPY_CHARS = 1000;
    /** The last copy sent, so one Ctrl+C held down does not send twice. */
    let lastCopy = '';

    /**
     * What the copy will carry. A selection inside an input or a textarea is
     * not part of the document's selection in every engine, so the focused
     * field is read directly when it is the one with the selection in it.
     */
    function copiedText(): string {
      const f = asTextField(deepActive());
      if (f) {
        if (isSensitiveField(f)) return '';
        try {
          const { selectionStart, selectionEnd } = f;
          if (selectionStart != null && selectionEnd != null && selectionEnd > selectionStart) {
            return f.value.slice(selectionStart, selectionEnd).replace(/\s+/g, ' ').trim();
          }
        } catch {
          // no selection API on this input type
        }
      }
      return (getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim();
    }

    function onCopy(): void {
      if (!ctx.isValid) return;
      // A page asking for a password is not one to copy out of.
      if (hasPasswordField()) return;
      const text = copiedText().slice(0, MAX_COPY_CHARS);
      // A copy carries no field to judge it by, so the shape of the string decides.
      if (text.length < MIN_COPY_CHARS || text === lastCopy || looksSecret(text)) return;
      lastCopy = text;
      post({ type: 'copied', url: location.href, title: document.title, text });
      log(`copied "${clip(text, 60)}"`);
    }

    document.addEventListener('copy', onCopy, true);
    document.addEventListener('cut', onCopy, true);

    // -----------------------------------------------------------------------
    // The status pill, and the two shortcuts the worker relays here

    /** Whether this page has already been told about the pause it is under. */
    let pauseNoted = false;

    async function refreshStatus(): Promise<void> {
      const info = await safeSendMessage('getStatus', undefined);
      if (!info || !ctx.isValid) return;
      status.update(info);
      chip.setSound(info.sound);
      // With the pill off, a pause looks exactly like carat having nothing to
      // say. Break that silence once, then leave the page alone.
      if (info.reason !== 'paused') pauseNoted = false;
      else if (!info.show && !pauseNoted) {
        pauseNoted = true;
        status.notice(PAUSED_NOTICE, PAUSE_NOTICE_MS);
      }
    }
    void refreshStatus();
    const statusTimer = setInterval(() => void refreshStatus(), STATUS_POLL_MS);

    const stopForce = onMessage('forceSuggest', () => {
      if (!ctx.isValid) return;
      // Asking for one is the plainest way of saying the quiet minute is over.
      quiet.end();
      activity++;
      schedule('force');
    });
    const stopCleared = onMessage('contextCleared', () => {
      if (!ctx.isValid) return;
      clearSuggestion();
      clearGhost();
    });

    ctx.onInvalidated(() => {
      clearInterval(statusTimer);
      quiet.destroy();
      stopForce();
      stopCleared();
      chip.destroy();
      status.destroy();
      ring.hide();
      ghost.hide();
      port?.disconnect();
      port = null;
    });

    // A fresh page in the middle of a flow (you just clicked "Checkout") gets a
    // prediction without waiting for you to touch it. The worker ignores this
    // unless you interacted in this tab (or its opener) within the last minute.
    connect();
    schedule('load');
  },
});
