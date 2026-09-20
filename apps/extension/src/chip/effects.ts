import { FX_CSS, TIMING } from './styles';

/**
 * The marks carat leaves on the page's own controls. Every one of them is an
 * overlay box of carat's own, positioned over the control's rect in a fixed,
 * pointer-events-none host: nothing on the page is styled, so nothing the
 * page laid out can move.
 */
export type FxKind = 'outline' | 'flash' | 'tint' | 'ripple';

const FX_ATTR = 'data-carat-fx';
/** The ripple's diameter before it grows; the spec's 40px circle. */
const RIPPLE_PX = 40;

export interface Effects {
  /** A hairline round the control a new field chip is about. */
  outline(el: Element): void;
  /** The control carat just acted on: a bloom, plus a tint when a value went in. */
  flash(el: Element, opts?: { tint?: boolean; amber?: boolean }): void;
  /** A click: a circle out of the control's centre. */
  ripple(el: Element, opts?: { amber?: boolean }): void;
  /** Take every mark off now — the user acted, and carat is out of the way. */
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

  function mark(kind: FxKind, ms: number, amber: boolean): HTMLElement | null {
    if (still() && kind === 'ripple') return null;
    if (!host.isConnected) doc.documentElement.appendChild(host);
    const el = doc.createElement('div');
    el.className = `fx ${kind}`;
    el.dataset.kind = kind;
    if (amber) el.classList.add('is-amber');
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
    outline(target) {
      const el = mark('outline', TIMING.outlineMs, false);
      if (el) over(el, target, 2);
      announce();
    },
    flash(target, opts = {}) {
      const amber = opts.amber === true;
      const el = mark('flash', TIMING.flashMs, amber);
      if (el) over(el, target, 2);
      if (opts.tint === true) {
        const tint = mark('tint', TIMING.flashMs, amber);
        if (tint) over(tint, target, 0);
      }
      announce();
    },
    ripple(target, opts = {}) {
      const el = mark('ripple', TIMING.rippleMs, opts.amber === true);
      if (el) {
        const r = target.getBoundingClientRect();
        el.style.left = `${Math.round(r.left + r.width / 2 - RIPPLE_PX / 2)}px`;
        el.style.top = `${Math.round(r.top + r.height / 2 - RIPPLE_PX / 2)}px`;
        el.style.width = `${RIPPLE_PX}px`;
        el.style.height = `${RIPPLE_PX}px`;
      }
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
