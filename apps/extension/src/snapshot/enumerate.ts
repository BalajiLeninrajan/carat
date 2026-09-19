import type { FieldDescriptor } from '@carat/shared';
import { normalizeWhitespace, truncate } from '@carat/shared';
import { isVisible } from '../capture/visibility';
import { inViewport } from '../scroll';
import { fingerprintOf, placeholderOf } from './fingerprint';
import { labelOf, nearbyText } from './labels';
import { serializeFields } from './serialize';

export const MAX_FIELDS = 12;
export const FIELD_ID_ATTR = 'data-carat-id';

const EXCLUDED_INPUT_TYPES = [
  'hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio',
  'file', 'password', 'range', 'color',
];
const ROLES = new Set(['textbox', 'combobox', 'searchbox']);
const NON_TEXT_HOSTS = 'button,select,a,summary';
const SELECTOR = [
  `input${EXCLUDED_INPUT_TYPES.map((t) => `:not([type="${t}" i])`).join('')}`,
  'textarea',
  '[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i]',
  '[role="textbox"],[role="combobox"],[role="searchbox"]',
].join(',');

export interface FieldEntry {
  el: Element;
  fingerprint: string;
}

export interface FieldSnapshot {
  descriptors: FieldDescriptor[];
  registry: Map<string, FieldEntry>;
}

interface Candidate {
  el: Element;
  rect: DOMRect;
  focused: boolean;
  inViewport: boolean;
  value: string;
  order: number;
}

/**
 * Fillable fields anywhere on the page, ranked focused first, then those in
 * the viewport, then widest, then DOM order; capped at MAX_FIELDS and at the
 * serialized byte budget, so off-screen fields are the first to go. Each kept
 * element gets a `data-carat-id` matching its descriptor id; an off-screen one
 * is flagged `o: 1` so the model knows carat would have to scroll to it.
 */
export function enumerateFields(doc: Document, win: Window | null = doc.defaultView): FieldSnapshot {
  const registry = new Map<string, FieldEntry>();
  // Sub-frames are never snapshotted; only the top document gets a chip.
  if (!win || win.self !== win.top) return { descriptors: [], registry };

  for (const stale of doc.querySelectorAll(`[${FIELD_ID_ATTR}]`)) stale.removeAttribute(FIELD_ID_ATTR);

  const active = doc.activeElement;
  const candidates: Candidate[] = [];
  Array.from(doc.querySelectorAll(SELECTOR)).forEach((el, order) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (!isVisible(el, win)) return;
    if (isInert(el) || el.closest('[aria-hidden="true"]')) return;
    // Radix/shadcn-style `<button role="combobox">` and `<select role=...>` hold no text to fill.
    if (!isNativeControl(el) && !isEditableHost(el) && el.matches(NON_TEXT_HOSTS)) return;
    const focused = el === active;
    const value = valueOf(el);
    // A field the user already filled is theirs; only a focused one is still described.
    if (value && !focused) return;
    candidates.push({ el, rect, focused, inViewport: inViewport(el, win), value, order });
  });

  const ranked = dropRoleWrappers(candidates)
    .sort(
      (a, b) =>
        Number(b.focused) - Number(a.focused) ||
        Number(b.inViewport) - Number(a.inViewport) ||
        b.rect.width - a.rect.width ||
        a.order - b.order,
    )
    .slice(0, MAX_FIELDS);

  const descriptors = ranked.map((c, idx) => describe(c, `f${idx}`, doc));
  const kept = serializeFields(descriptors).descriptors;
  kept.forEach((d, idx) => {
    const { el } = ranked[idx]!;
    el.setAttribute(FIELD_ID_ATTR, d.i);
    registry.set(d.i, { el, fingerprint: fingerprintOf(el) });
  });
  return { descriptors: kept, registry };
}

function describe(c: Candidate, id: string, doc: Document): FieldDescriptor {
  const { el } = c;
  const d: FieldDescriptor = { i: id, t: typeOf(el) };
  const nm = el.getAttribute('name') || el.id;
  const ph = placeholderOf(el);
  const al = el.getAttribute('aria-label');
  const lb = labelOf(el, doc);
  const nb = nearbyText(el);
  const ac = el.getAttribute('autocomplete');
  if (nm) d.nm = truncate(nm, 40);
  if (ph) d.ph = truncate(normalizeWhitespace(ph), 60);
  if (al) d.al = truncate(normalizeWhitespace(al), 60);
  if (lb) d.lb = truncate(lb, 60);
  if (nb && nb !== lb) d.nb = truncate(nb, 80);
  if (ac) d.ac = ac;
  if (c.value) d.v = truncate(c.value, 40);
  if (c.focused) d.f = 1;
  d.w = c.rect.width < 160 ? 's' : c.rect.width < 400 ? 'm' : 'l';
  if (!c.inViewport) d.o = 1;
  return d;
}

function typeOf(el: Element): string {
  const role = el.getAttribute('role');
  if (role && ROLES.has(role)) return role;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return `input:${(el as HTMLInputElement).type}`;
  if (tag === 'textarea') return 'textarea';
  return 'ce';
}

function isNativeControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

function isEditableHost(el: Element): boolean {
  const ce = el.getAttribute('contenteditable');
  return ce !== null && ce.toLowerCase() !== 'false';
}

export function valueOf(el: Element): string {
  if (isNativeControl(el)) return el.value.trim();
  return normalizeWhitespace(el.textContent ?? '');
}

function isInert(el: Element): boolean {
  if (isNativeControl(el) && (el.disabled || el.readOnly)) return true;
  if (el.closest('fieldset[disabled],[aria-disabled="true"],[inert]')) return true;
  return el.getAttribute('aria-readonly') === 'true';
}

/** ARIA 1.1 comboboxes put the role on a wrapper around the real input; keep only the input. */
function dropRoleWrappers(candidates: Candidate[]): Candidate[] {
  return candidates.filter((c) => {
    if (isNativeControl(c.el) || isEditableHost(c.el)) return true;
    return !candidates.some((o) => o !== c && c.el.contains(o.el));
  });
}
