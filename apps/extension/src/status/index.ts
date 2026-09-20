import type { StatusInfo } from './info';
import { STATUS_CSS } from './styles';

export interface StatusLine {
  update(info: StatusInfo): void;
  /** A suggestion request is in flight; the dot pulses until `setBusy(false)`. */
  setBusy(busy: boolean): void;
  /** Milliseconds left of a Shift+Tab snooze, or null when carat is not in one. */
  setQuiet(left: number | null): void;
  destroy(): void;
  readonly visible: boolean;
}

const HOST_ATTR = 'data-carat-status';

const REASON_TEXT: Record<NonNullable<StatusInfo['reason']>, string> = {
  disabled: 'off',
  blocked: 'off for this site',
  'no-key': 'no API key',
  'not-http': 'off here',
  paused: 'paused (debugger banner dismissed)',
};

/**
 * A small pill in the bottom-left corner, clear of the tab-offer banner at the bottom centre.
 * It never takes pointer events, so
 * it cannot get between the user and the page; it only reports.
 */
export function createStatusLine(doc: Document = document): StatusLine {
  const host = doc.createElement('div');
  host.setAttribute(HOST_ATTR, '');
  host.style.cssText =
    'all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483646;display:none;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = STATUS_CSS;
  const pill = doc.createElement('div');
  pill.className = 'line';
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'off');
  const dot = doc.createElement('span');
  dot.className = 'dot';
  const text = doc.createElement('span');
  text.className = 'text';
  pill.append(dot, text);
  root.append(style, pill);

  let visible = false;
  let busy = false;
  let quiet: number | null = null;
  let info: StatusInfo | null = null;

  const mount = (): void => {
    if (!host.isConnected) doc.documentElement.append(host);
  };

  const render = (): void => {
    if (!info || !info.show) {
      host.style.display = 'none';
      visible = false;
      return;
    }
    mount();
    host.style.display = 'block';
    visible = true;
    pill.classList.toggle('is-running', info.running);
    pill.classList.toggle('is-busy', busy && info.running && quiet === null);
    pill.classList.toggle('is-quiet', quiet !== null && info.running);
    text.textContent = statusText(info, busy, quiet);
  };

  return {
    update(next) {
      info = next;
      render();
    },
    setBusy(next) {
      busy = next;
      render();
    },
    setQuiet(left) {
      quiet = left;
      render();
    },
    destroy() {
      host.remove();
      visible = false;
    },
    get visible() {
      return visible;
    },
  };
}

export function statusText(info: StatusInfo, busy = false, quietLeft: number | null = null): string {
  if (!info.running) return `carat · ${REASON_TEXT[info.reason ?? 'disabled']}`;
  // Nothing is in flight during a snooze, so the countdown is all there is to say.
  if (quietLeft !== null) return `carat · quiet ${clock(quietLeft)}`;
  return busy ? `carat · ${info.model} · thinking` : `carat · ${info.model}`;
}

/** What is left of the minute, as `0:42`. Rounded up, so the last second still reads 0:01. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
