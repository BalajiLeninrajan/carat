import type { ElementDescriptor, ElementRole } from '@carat/shared';
import { CONTROL_ROLES, elementKey, isDestructiveName, isMoneyName, isPrimaryActionName, normalizeWhitespace, truncate } from '@carat/shared';
import { isVisible } from '../capture/visibility';
import { isButtonish, isDetails, isInput, isSelect } from '../dom/tags';
import type { FrameRef } from '../frames/merge';
import { inViewport, viewportRect } from '../scroll';
import { childDocuments } from '../snapshot/frames';
import { nearbyText, textExcluding } from '../snapshot/labels';
import { serializeDescriptors } from '../snapshot/serialize';
import type { Site } from './links';
import { MAX_LINKS, enumerateLinks } from './links';
import { accessibleName } from './name';

export const MAX_ELEMENTS = 16;
export const MAX_ELEMENTS_BYTES = 2048;
export const ELEMENT_ID_ATTR = 'data-carat-el';
/** Elements are described from this many viewport heights above the top of the viewport... */
export const ELEMENT_WINDOW_ABOVE = 2;
/** ...to this many below it. Fields have no such window. */
export const ELEMENT_WINDOW_BELOW = 4;

const NAME_MAX = 60;
const VALUE_MAX = 40;
const OPTIONS_MAX = 8;
const OPTION_CHARS = 20;
/** A card needs this much text of its own before its Select button is folded into it. */
const CARD_MIN_TEXT = 8;
const CARD_MAX_CLIMB = 6;

// Anchors here only when they act as buttons; real links come from `enumerateLinks`, with their destination.
const SELECTOR = [
  'button',
  'input[type="button" i],input[type="submit" i],input[type="image" i]',
  'a[role="button" i],a:not([href]),a[href=""],a[href="#"],a[href^="javascript:" i]',
  '[role="button" i],[role="checkbox" i],[role="switch" i],[role="radio" i],[role="slider" i],[role="tab" i],[role="menuitem" i]',
  '[role="option" i],[aria-selected]:not([role]),[aria-pressed]:not(button):not([role])',
  'input[type="checkbox" i],input[type="radio" i],input[type="range" i]',
  'select:not([multiple])',
  'summary',
].join(',');

const ARIA_ROLES: ReadonlySet<string> = new Set(['button', 'checkbox', 'switch', 'radio', 'slider', 'tab', 'menuitem', 'option']);
const PRIMARY_HINT = /\bprimary\b|\bcta\b|btn-primary|Button--primary|mat-primary/i;
/** A button whose only job is to pick the card around it: "Select", "Select flight", "Choose this fare". */
export const SELECT_BUTTON = /^(?:select|choose|pick)(?:\s+(?:this|flight|fare|option|plan|room|seat|rate|ticket|departure|return|outbound|inbound))*$/i;
/** The card climb stops at a list or a form: those hold many cards, not one. */
const CARD_BOUNDARY = 'ul,ol,form,main,body,table,[role="list"],[role="listbox"],[role="radiogroup"],[role="group"]';
const SELECTED_CLASS = /(?:^|[\s_-])(?:selected|chosen|active|is-selected|is-active)(?:$|[\s_-])/i;

export interface ElementEntry {
  el: Element;
  role: ElementRole;
  name: string;
  /** `role|name`, what feedback carries; the background rebuilds the same key from the descriptor. */
  key: string;
  /** The control pays, buys or books: the chip takes Enter and the accept is logged. */
  money?: true;
  /** Set when the element lives in a cross-origin frame: `el` is the frame element and the child performs. */
  frame?: FrameRef;
  /** A real link's destination, as a registrable domain; the chip says `Open "…" on <site>`. */
  site?: string;
  /** Where the chip sits when that is not the element itself: a result's title inside its anchor. */
  at?: Element;
}

export interface ElementSnapshot {
  descriptors: ElementDescriptor[];
  registry: Map<string, ElementEntry>;
}

export interface EnumerateOptions {
  /** Money controls (Pay, Book now) are described, flagged `m: 1`. Off: they are left out entirely. */
  allowPayments?: boolean;
  /** This document is a child frame whose agent reports to the top frame; enumerate it anyway. */
  frame?: boolean;
  /** The page the results-page adapter is picked for; defaults to the document's own location. */
  site?: Site;
  /** Byte budget for the descriptors, once the page state has taken its share of the request. */
  maxBytes?: number;
}

interface Candidate {
  el: Element;
  role: ElementRole;
  name: string;
  rect: DOMRect;
  primary: boolean;
  inViewport: boolean;
  order: number;
  money: boolean;
  selected: boolean;
  /** The frame number when the element sits in a same-origin child frame. */
  fr?: number;
  site?: string;
  at?: Element;
}

// Value-bearing controls first, then real links, then plain buttons and the rest.
function tier(c: Candidate): number {
  if (CONTROL_ROLES.has(c.role)) return 0;
  return c.site ? 1 : 2;
}

/**
 * Interactive elements carat could act on, from two viewport heights above
 * to four below, ranked primary first, then those in the viewport, then
 * value-bearing controls, then real links (in page order), then plain
 * buttons by size and DOM order; capped at MAX_ELEMENTS in all, MAX_LINKS of
 * them links, and `opts.maxBytes`, the budget left over once the page state
 * has taken its share of the request, so off-screen ones go first. An
 * off-screen element is flagged `o: 1`. Anything with a destructive name is
 * left out here, before the model ever sees it; a money name is left out too
 * unless payments are allowed, and then flagged `m: 1`. A card with a Select
 * button, or a `role=option`, is one `option` element: the card. `opts.site`
 * names the page for the host adapter; it defaults to the document's own
 * location.
 */
export function enumerateElements(doc: Document, win: Window | null = doc.defaultView, opts: EnumerateOptions = {}): ElementSnapshot {
  const maxBytes = opts.maxBytes ?? MAX_ELEMENTS_BYTES;
  const registry = new Map<string, ElementEntry>();
  if (!win || (!opts.frame && win.self !== win.top)) return { descriptors: [], registry };

  const vh = win.innerHeight;
  const candidates: Candidate[] = [];
  const seen = new Set<Element>();
  const documents = [{ doc, num: undefined as number | undefined }, ...childDocuments(doc).map((c) => ({ doc: c.doc, num: c.num }))];
  let order = 0;
  for (const { doc: d, num } of documents) {
    for (const stale of d.querySelectorAll(`[${ELEMENT_ID_ATTR}]`)) stale.removeAttribute(ELEMENT_ID_ATTR);
    const ownWin = d.defaultView ?? win;
    for (const raw of d.querySelectorAll(SELECTOR)) {
      order++;
      let role = roleOf(raw);
      if (!role) continue;
      let el = raw;
      // "Select flight" on a card means the card; describe the card once, however many ways it is reached.
      if (role === 'button' && SELECT_BUTTON.test(normalizeWhitespace(raw.textContent ?? raw.getAttribute('aria-label') ?? ''))) {
        const card = cardAround(raw);
        if (card) {
          el = card;
          role = 'option';
        }
      }
      if (seen.has(el)) continue;
      const rect = viewportRect(el, win);
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.top < -ELEMENT_WINDOW_ABOVE * vh || rect.top > ELEMENT_WINDOW_BELOW * vh) continue;
      if (!isVisible(el, ownWin) || isInert(el) || el.closest('[aria-hidden="true"]')) continue;
      if (role === 'radio' && toggleState(el) === 'on') continue;
      const name = role === 'option' ? cardName(el, d) : truncate(accessibleName(el, d), NAME_MAX);
      if (!name || isDestructiveName(name)) continue;
      const money = isMoneyName(name);
      if (money && !opts.allowPayments) continue;
      seen.add(el);
      candidates.push({
        el,
        role,
        name,
        rect,
        primary: isPrimary(el),
        inViewport: inViewport(el, win),
        order,
        money,
        selected: role === 'option' && isSelectedCard(el),
        ...(num !== undefined ? { fr: num } : {}),
      });
    }
  }
  // Real links come last: they are ranked after the controls and capped on their own.
  for (const link of enumerateLinks(doc, win, opts.site ?? siteOf(doc))) {
    candidates.push({
      el: link.el,
      role: 'link',
      name: link.name,
      rect: link.rect,
      primary: false,
      inViewport: link.inViewport,
      order: link.order,
      money: false,
      selected: false,
      site: link.site,
      at: link.at,
    });
  }
  markProminent(candidates);

  const sorted = candidates.sort(
    (a, b) =>
      Number(b.primary) - Number(a.primary) ||
      Number(b.inViewport) - Number(a.inViewport) ||
      tier(a) - tier(b) ||
      (a.site && b.site ? 0 : b.rect.width * b.rect.height - a.rect.width * a.rect.height) ||
      a.order - b.order,
  );
  const ranked: Candidate[] = [];
  let links = 0;
  for (const c of sorted) {
    if (ranked.length >= MAX_ELEMENTS) break;
    if (c.site && links >= MAX_LINKS) continue;
    if (c.site) links++;
    ranked.push(c);
  }

  const descriptors = ranked.map((c, idx) => describe(c, `e${idx}`));
  const kept = serializeDescriptors(descriptors, Math.max(0, maxBytes)).descriptors;
  kept.forEach((d, idx) => {
    const { el, role, name, money, site: dest, at } = ranked[idx]!;
    el.setAttribute(ELEMENT_ID_ATTR, d.i);
    registry.set(d.i, {
      el,
      role,
      name,
      key: elementKey(role, name),
      ...(money ? { money: true } : {}),
      ...(dest ? { site: dest } : {}),
      ...(at && at !== el ? { at } : {}),
    });
  });
  return { descriptors: kept, registry };
}

function siteOf(doc: Document): Site {
  return { host: doc.location.host, path: doc.location.pathname };
}

function describe(c: Candidate, id: string): ElementDescriptor {
  const { el, role } = c;
  const d: ElementDescriptor = { i: id, r: role, nm: c.name };
  if (c.site) {
    // A link is its title and its site; nearby text would only repeat the result around it.
    d.h = c.site;
    if (!c.inViewport) d.o = 1;
    return d;
  }
  if (role === 'checkbox' || role === 'switch' || role === 'radio') d.st = toggleState(el) ?? 'off';
  else if (role === 'disclosure') d.st = isExpanded(el) ? 'open' : 'closed';
  else if (role === 'tab' && el.getAttribute('aria-selected') === 'true') d.st = 'selected';
  else if (role === 'option') {
    if (c.selected) d.sel = 1;
  } else if (role === 'slider') Object.assign(d, sliderFacts(el));
  else if (role === 'select' && isSelect(el)) {
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
  if (!c.inViewport) d.o = 1;
  if (c.money) d.m = 1;
  if (c.fr !== undefined) d.fr = c.fr;
  return d;
}

/** Which of carat's roles an element plays, or null when it is none of them. */
export function roleOf(el: Element): ElementRole | null {
  const aria = el.getAttribute('role')?.toLowerCase();
  const tag = el.tagName.toLowerCase();
  const type = isInput(el) ? el.type : '';
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
  // A card that says whether it is chosen, with no role of its own: a fare, a room, a plan.
  if (!aria && (el.hasAttribute('aria-selected') || el.hasAttribute('aria-pressed'))) return 'option';
  return null;
}

/** 'on' or 'off' for anything checkable (native, aria-checked or aria-pressed), else null. */
export function toggleState(el: Element): 'on' | 'off' | null {
  if (isInput(el) && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'on' : 'off';
  const checked = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
  if (checked === null) return null;
  return checked.toLowerCase() === 'true' ? 'on' : 'off';
}

function isExpanded(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'summary') return isDetails(el.parentElement) && el.parentElement.open;
  return el.getAttribute('aria-expanded') === 'true';
}

/**
 * The card a Select button belongs to: the widest ancestor that still holds
 * only this one Select button and has some text of its own, stopping short
 * of the list or form around all the cards. Null when the button stands alone.
 */
export function cardAround(button: Element): Element | null {
  let card: Element | null = null;
  let node = button.parentElement;
  for (let depth = 0; node && depth < CARD_MAX_CLIMB; depth++, node = node.parentElement) {
    if (node.matches(CARD_BOUNDARY)) break;
    if (selectButtonsIn(node) > 1) break;
    card = node;
  }
  if (!card) return null;
  return textExcluding(card, button).length >= CARD_MIN_TEXT ? card : null;
}

function selectButtonsIn(root: Element): number {
  let n = 0;
  for (const b of root.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')) {
    const label = isInput(b) ? b.value : (b.textContent ?? b.getAttribute('aria-label') ?? '');
    if (SELECT_BUTTON.test(normalizeWhitespace(label))) n++;
  }
  return n;
}

/** What a card is called: its own visible text minus its Select button, else its aria-label. */
function cardName(card: Element, doc: Document): string {
  const button = Array.from(card.querySelectorAll('button,[role="button"]')).find((b) =>
    SELECT_BUTTON.test(normalizeWhitespace(b.textContent ?? b.getAttribute('aria-label') ?? '')),
  );
  const own = button ? textExcluding(card, button) : normalizeWhitespace(card.textContent ?? '');
  return truncate(own || accessibleName(card, doc), NAME_MAX);
}

/** Whether a card is already the chosen one: an ARIA state, a checked radio inside, or a class that says so. */
export function isSelectedCard(el: Element): boolean {
  for (const attr of ['aria-selected', 'aria-pressed', 'aria-checked']) {
    if (el.getAttribute(attr)?.toLowerCase() === 'true') return true;
  }
  if (el.hasAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') return true;
  if (el.querySelector('input[type="radio"]:checked,[role="radio"][aria-checked="true"]')) return true;
  return SELECTED_CLASS.test(el.className);
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
  if (isInput(el)) {
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
  if (isButtonish(el) && el.type === 'submit' && el.closest('form')) return true;
  return PRIMARY_HINT.test(`${el.className} ${el.id}`);
}

/**
 * A page with no submit button and no primary class still has a primary
 * action: the biggest continue-style button in view (Search on Google
 * Flights, Continue on a checkout step). Only when nothing else claimed it.
 */
function markProminent(candidates: Candidate[]): void {
  if (candidates.some((c) => c.primary)) return;
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (c.role !== 'button' || !c.inViewport || c.money || !isPrimaryActionName(c.name)) continue;
    if (!best || c.rect.width * c.rect.height > best.rect.width * best.rect.height) best = c;
  }
  if (best) best.primary = true;
}

function isInert(el: Element): boolean {
  if ('disabled' in el && (el as { disabled: unknown }).disabled === true) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return el.closest('fieldset[disabled],[aria-disabled="true"],[inert]') !== null;
}
