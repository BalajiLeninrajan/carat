import type { ElementDescriptor, ElementRole } from '@carat/shared';
import { CONTROL_ROLES, elementKey, isDestructiveName, normalizeWhitespace, truncate } from '@carat/shared';
import { isVisible } from '../capture/visibility';
import { nearbyText } from '../snapshot/labels';
import { serializeDescriptors } from '../snapshot/serialize';
import { accessibleName } from './name';

export const MAX_ELEMENTS = 16;
export const MAX_ELEMENTS_BYTES = 2048;
export const ELEMENT_ID_ATTR = 'data-carat-el';

const NAME_MAX = 60;
const VALUE_MAX = 40;
const OPTIONS_MAX = 8;
const OPTION_CHARS = 20;

// Links only when they act as buttons: a real href is navigation, which is not carat's to click.
const SELECTOR = [
  'button',
  'input[type="button" i],input[type="submit" i],input[type="image" i]',
  'a[role="button" i],a:not([href]),a[href=""],a[href="#"],a[href^="javascript:" i]',
  '[role="button" i],[role="checkbox" i],[role="switch" i],[role="radio" i],[role="slider" i],[role="tab" i],[role="menuitem" i]',
  'input[type="checkbox" i],input[type="radio" i],input[type="range" i]',
  'select:not([multiple])',
  'summary',
].join(',');

const ARIA_ROLES: ReadonlySet<string> = new Set(['button', 'checkbox', 'switch', 'radio', 'slider', 'tab', 'menuitem']);
const PRIMARY_HINT = /\bprimary\b|\bcta\b|btn-primary|Button--primary|mat-primary/i;

export interface ElementEntry {
  el: Element;
  role: ElementRole;
  name: string;
  /** `role|name`, what feedback carries; the background rebuilds the same key from the descriptor. */
  key: string;
}

export interface ElementSnapshot {
  descriptors: ElementDescriptor[];
  registry: Map<string, ElementEntry>;
}

interface Candidate {
  el: Element;
  role: ElementRole;
  name: string;
  rect: DOMRect;
  primary: boolean;
  inViewport: boolean;
  order: number;
}

/**
 * Interactive elements carat could act on, ranked primary first, then those
 * in the viewport, then value-bearing controls before plain buttons, then by
 * size and DOM order; capped at MAX_ELEMENTS and the byte budget. Anything
 * with a destructive name is left out here, before the model ever sees it.
 */
export function enumerateElements(doc: Document, win: Window | null = doc.defaultView): ElementSnapshot {
  const registry = new Map<string, ElementEntry>();
  if (!win || win.self !== win.top) return { descriptors: [], registry };

  for (const stale of doc.querySelectorAll(`[${ELEMENT_ID_ATTR}]`)) stale.removeAttribute(ELEMENT_ID_ATTR);

  const vh = win.innerHeight;
  const vw = win.innerWidth;
  const candidates: Candidate[] = [];
  Array.from(doc.querySelectorAll(SELECTOR)).forEach((el, order) => {
    const role = roleOf(el);
    if (!role) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (rect.top < -vh || rect.top > 2 * vh) return;
    if (!isVisible(el, win) || isInert(el) || el.closest('[aria-hidden="true"]')) return;
    if (role === 'radio' && toggleState(el) === 'on') return;
    const name = truncate(accessibleName(el, doc), NAME_MAX);
    if (!name || isDestructiveName(name)) return;
    const inViewport = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    candidates.push({ el, role, name, rect, primary: isPrimary(el), inViewport, order });
  });

  const ranked = candidates
    .sort(
      (a, b) =>
        Number(b.primary) - Number(a.primary) ||
        Number(b.inViewport) - Number(a.inViewport) ||
        Number(CONTROL_ROLES.has(b.role)) - Number(CONTROL_ROLES.has(a.role)) ||
        b.rect.width * b.rect.height - a.rect.width * a.rect.height ||
        a.order - b.order,
    )
    .slice(0, MAX_ELEMENTS);

  const descriptors = ranked.map((c, idx) => describe(c, `e${idx}`));
  const kept = serializeDescriptors(descriptors, MAX_ELEMENTS_BYTES).descriptors;
  kept.forEach((d, idx) => {
    const { el, role, name } = ranked[idx]!;
    el.setAttribute(ELEMENT_ID_ATTR, d.i);
    registry.set(d.i, { el, role, name, key: elementKey(role, name) });
  });
  return { descriptors: kept, registry };
}

function describe(c: Candidate, id: string): ElementDescriptor {
  const { el, role } = c;
  const d: ElementDescriptor = { i: id, r: role, nm: c.name };
  if (role === 'checkbox' || role === 'switch' || role === 'radio') d.st = toggleState(el) ?? 'off';
  else if (role === 'disclosure') d.st = isExpanded(el) ? 'open' : 'closed';
  else if (role === 'tab' && el.getAttribute('aria-selected') === 'true') d.st = 'selected';
  else if (role === 'slider') Object.assign(d, sliderFacts(el));
  else if (role === 'select' && el instanceof HTMLSelectElement) {
    const current = el.selectedOptions[0]?.text.trim();
    if (current) d.v = truncate(current, VALUE_MAX);
    const op = Array.from(el.options)
      .map((o) => truncate(normalizeWhitespace(o.text), OPTION_CHARS))
      .filter(Boolean)
      .slice(0, OPTIONS_MAX);
    if (op.length) d.op = op;
  }
  const nb = nearbyText(el);
  if (nb && nb !== c.name) d.nb = truncate(nb, 80);
  if (c.primary) d.p = 1;
  return d;
}

/** Which of carat's roles an element plays, or null when it is none of them. */
export function roleOf(el: Element): ElementRole | null {
  const aria = el.getAttribute('role')?.toLowerCase();
  const tag = el.tagName.toLowerCase();
  const type = el instanceof HTMLInputElement ? el.type : '';
  const buttonLike = aria === 'button' || tag === 'button' || (tag === 'input' && (type === 'button' || type === 'submit' || type === 'image'));
  if (buttonLike) {
    if (el.hasAttribute('aria-pressed')) return 'switch';
    if (el.hasAttribute('aria-expanded')) return 'disclosure';
    return 'button';
  }
  if (aria && ARIA_ROLES.has(aria)) return aria as ElementRole;
  if (tag === 'a') return 'link';
  if (tag === 'summary') return 'disclosure';
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
  }
  return null;
}

/** 'on' or 'off' for anything checkable (native, aria-checked or aria-pressed), else null. */
export function toggleState(el: Element): 'on' | 'off' | null {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'on' : 'off';
  const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
  if (checked === null) return null;
  return checked.toLowerCase() === 'true' ? 'on' : 'off';
}

function isExpanded(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'summary') return el.parentElement instanceof HTMLDetailsElement && el.parentElement.open;
  return el.getAttribute('aria-expanded') === 'true';
}

export interface SliderFacts {
  v?: string;
  min?: number;
  max?: number;
  step?: number;
}

/** Value and range of a native range input or an ARIA slider, numbers only. */
export function sliderFacts(el: Element): SliderFacts {
  const out: SliderFacts = {};
  const num = (v: string | null | undefined): number | undefined => {
    if (v === null || v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  if (el instanceof HTMLInputElement) {
    out.v = el.value;
    out.min = num(el.min) ?? 0;
    out.max = num(el.max) ?? 100;
    const step = num(el.step);
    if (step !== undefined && step > 0) out.step = step;
    return out;
  }
  const now = num(el.getAttribute('aria-valuenow'));
  if (now !== undefined) out.v = String(now);
  out.min = num(el.getAttribute('aria-valuemin')) ?? 0;
  out.max = num(el.getAttribute('aria-valuemax')) ?? 100;
  const step = num(el.getAttribute('step') ?? el.getAttribute('data-step'));
  if (step !== undefined && step > 0) out.step = step;
  return out;
}

function isPrimary(el: Element): boolean {
  if ((el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.type === 'submit' && el.closest('form')) return true;
  return PRIMARY_HINT.test(`${el.className} ${el.id}`);
}

function isInert(el: Element): boolean {
  if ('disabled' in el && (el as { disabled: unknown }).disabled === true) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return el.closest('fieldset[disabled],[aria-disabled="true"],[inert]') !== null;
}
