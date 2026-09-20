import { FX_CSS, TIMING } from './styles';

/**
 * The mark caret leaves on a page's own control. It is an overlay box of
 * caret's own, positioned over the control's rect in a fixed,
 * pointer-events-none host: nothing on the page is styled, so nothing the
 * page laid out can move.
 */
export type FxKind = 'flash';

const FX_ATTR = 'data-caret-fx';

export interface Effects {
  /** The control caret just acted on, outlined for a moment as a receipt. */
  flash(el: Element, opts?: { alarm?: boolean }): void;
  /** Take every mark off now — the user acted, and caret is out of the way. */
  clear(): void;
  destroy(): void;
}

export function createEffects(doc: Document = document, still: () => boolean = () => false): Effects {
  const host = doc.createElement('div');
  host.setAttribute(FX_ATTR, '');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483645;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = FX_CSS;
  root.append(style);

  /** Every mark on screen with the timer that takes it off, so a clear takes them all. */
  const live = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  /** What is on screen, mirrored onto the host: the shadow root is closed, so tests read it here. */
  function announce(): void {
    const kinds = [...live.keys()].map((el) => el.dataset.kind ?? '');
    host.setAttribute(FX_ATTR, [...new Set(kinds)].sort().join(' '));
  }

  function mark(kind: FxKind, ms: number, alarm: boolean): HTMLElement {
    if (!host.isConnected) doc.documentElement.appendChild(host);
    const el = doc.createElement('div');
    el.className = `fx ${kind}`;
    el.dataset.kind = kind;
    if (alarm) el.classList.add('is-alarm');
    // No motion allowed: the mark is simply there and then gone, for the same span.
    if (still()) el.classList.add('is-static');
    root.appendChild(el);
    live.set(
      el,
      setTimeout(() => remove(el), ms),
    );
    return el;
  }

  function remove(el: HTMLElement): void {
    const timer = live.get(el);
    if (timer !== undefined) clearTimeout(timer);
    live.delete(el);
    el.remove();
    announce();
  }

  /** Lay a mark over the control's box, with an even bleed all round. */
  function over(el: HTMLElement, target: Element, bleed: number): void {
    const r = target.getBoundingClientRect();
    el.style.left = `${Math.round(r.left - bleed)}px`;
    el.style.top = `${Math.round(r.top - bleed)}px`;
    el.style.width = `${Math.round(r.width + bleed * 2)}px`;
    el.style.height = `${Math.round(r.height + bleed * 2)}px`;
  }

  return {
    flash(target, opts = {}) {
      over(mark('flash', TIMING.flashMs, opts.alarm === true), target, 2);
      announce();
    },
    clear() {
      for (const el of [...live.keys()]) remove(el);
    },
    destroy() {
      this.clear();
      host.remove();
    },
  };
}
