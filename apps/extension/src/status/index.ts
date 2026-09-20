import type { StatusInfo } from '../background/status';
import { STATUS_CSS } from './styles';

export interface StatusLine {
  update(info: StatusInfo): void;
  /** A suggestion request is in flight; the dot pulses until `setBusy(false)`. */
  setBusy(busy: boolean): void;
  destroy(): void;
  readonly visible: boolean;
}

const HOST_ATTR = 'data-carat-status';

const REASON_TEXT: Record<NonNullable<StatusInfo['reason']>, string> = {
  disabled: 'off',
  'site-off': 'off for this site',
  denylisted: 'off here',
  'not-http': 'off here',
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
  let info: StatusInfo | null = null;

  const mount = (): void => {
    if (host.isConnected) return;
    try {
      doc.documentElement?.append(host);
    } catch {
      // Some very dynamic pages can detach or deny the root while we render.
    }
  };

  const render = (): void => {
    if (!info || !info.show) {
      host.style.display = 'none';
      visible = false;
      return;
    }
    mount();
    if (!host.isConnected) {
      visible = false;
      return;
    }
    host.style.display = 'block';
    visible = true;
    pill.classList.toggle('is-running', info.running);
    pill.classList.toggle('is-busy', busy && info.running);
    text.textContent = statusText(info, busy);
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
    destroy() {
      host.remove();
      visible = false;
    },
    get visible() {
      return visible;
    },
  };
}

export function statusText(info: StatusInfo, busy = false): string {
  if (!info.running) return `carat · ${REASON_TEXT[info.reason ?? 'disabled']}`;
  const model = info.provider === 'local' ? 'local' : info.model;
  return busy ? `carat · ${model} · thinking` : `carat · ${model}`;
}
