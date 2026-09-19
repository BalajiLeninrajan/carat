import { isDestructiveName, isMoneyName } from './destructive';
import type { Eagerness } from './eagerness';
import { EAGERNESS } from './eagerness';
import type { ElementDescriptor, ElementRole, FieldDescriptor, InteractSuggestion, InteractVerb, PageState } from './types';

/**
 * Verbs the content script can perform on each role, besides `scroll`, which
 * fits any role while the element is off-screen. Anything else is dropped
 * before it reaches a chip.
 */
export const VERBS_BY_ROLE: Record<ElementRole, readonly InteractVerb[]> = {
  button: ['click'],
  link: ['click'],
  tab: ['click'],
  menuitem: ['click'],
  disclosure: ['click'],
  option: ['click'],
  checkbox: ['check', 'uncheck'],
  switch: ['check', 'uncheck'],
  radio: ['check'],
  slider: ['set'],
  select: ['choose'],
};

export const ELEMENT_ROLES = Object.keys(VERBS_BY_ROLE) as ElementRole[];

/** Roles whose value or state another tab's text can name; a plain button only gets a chip after carat filled something. */
export const CONTROL_ROLES: ReadonlySet<ElementRole> = new Set(['checkbox', 'switch', 'radio', 'slider', 'select', 'option']);

// The first word (or two) of a button that moves a flow forward rather than committing a payment.
const PRIMARY_ACTION =
  /^(?:search|continue|next|select|choose|proceed|review|book|apply|done|save|create|find|explore|get started|confirm (?:details|selection|and continue))(?![a-z0-9])/;
const PRIMARY_NAME_MAX = 40;

/** A name like Search, Continue, Next, Select flight, Review trip, Book: what a page's primary action is usually called. Book now is money, not this. */
export function isPrimaryActionName(name: string): boolean {
  const n = name.replace(/\s+/g, ' ').trim().toLowerCase();
  return n.length > 0 && n.length <= PRIMARY_NAME_MAX && PRIMARY_ACTION.test(n) && !isMoneyName(n);
}

/** What decides whether a button or link may be clicked. */
export interface ClickGate {
  /** Carat filled something on this page in the last minute. */
  filled: boolean;
  /** A stored task marks this page as a step in an ongoing flow. */
  flow: boolean;
  eagerness: Eagerness;
  /** The page still has an empty field carat could fill. */
  fillable: boolean;
}

/**
 * Whether a button or link may be clicked at all (other roles always may).
 * After a fill, any button the model names. Otherwise only the page's primary
 * action with a continue-style name, and only when a flow is under way or, at
 * a level that allows it, when nothing on the page is left to fill.
 */
export function clickAllowed(d: Pick<ElementDescriptor, 'r' | 'nm' | 'p'>, gate: ClickGate): boolean {
  if (d.r !== 'button' && d.r !== 'link') return true;
  if (gate.filled) return true;
  if (d.p !== 1 || !isPrimaryActionName(d.nm)) return false;
  if (gate.flow) return true;
  return EAGERNESS[gate.eagerness].primaryWithoutFill && !gate.fillable;
}

export function isElementRole(v: unknown): v is ElementRole {
  return typeof v === 'string' && v in VERBS_BY_ROLE;
}

export function isInteractVerb(v: unknown): v is InteractVerb {
  return v === 'click' || v === 'check' || v === 'uncheck' || v === 'set' || v === 'choose' || v === 'scroll';
}

/** True when the descriptor marks the element as outside the viewport at snapshot time. */
export function isOffScreen(d: { o?: 1 }): boolean {
  return d.o === 1;
}

/** A scroll of the page itself, one viewport down: `verb: 'scroll'` with no element. */
export function isPageScroll(s: Pick<InteractSuggestion, 'verb' | 'elementId'>): boolean {
  return s.verb === 'scroll' && s.elementId === '';
}

/** What a page scroll is reported and suppressed as: a pseudo-element with this role and name. */
export const PAGE_SCROLL_ROLE = 'page';
export const PAGE_SCROLL_NAME = 'scroll';
/** The `done` entry a page scroll leaves in the page state until new content appears. */
export const PAGE_SCROLL_DONE = 'scroll';

/**
 * Buttons that move a form or checkout on without committing money or a
 * message. Anything that pays, orders or sends is on the destructive list and
 * never enumerated in the first place; "Submit" and "Sign up" are left out
 * here too, since they commit whatever the form holds.
 */
const CONTINUE_NAME = /^(?:continue|next|proceed|next step|continue to (?:shipping|payment|review|delivery|checkout)|review order|save|save and continue|done|apply)$/i;

export function isContinueName(name: string): boolean {
  return CONTINUE_NAME.test(name.replace(/\s+/g, ' ').trim());
}

const OPTIONAL = /\boptional\b/i;

/** A field whose label, placeholder or nearby text says it is optional. */
export function isOptionalField(f: Pick<FieldDescriptor, 'lb' | 'ph' | 'al' | 'nb'>): boolean {
  return OPTIONAL.test([f.lb, f.ph, f.al, f.nb].filter(Boolean).join(' '));
}

/**
 * Whether a form still has a field to fill before its Continue is the next
 * step. `fields` only lists empty (or focused) fields, so when any of them is
 * marked required only the required ones count; otherwise every empty one
 * does, except those that call themselves optional.
 */
export function emptyFieldRemains(fields: ReadonlyArray<Pick<FieldDescriptor, 'v' | 'rq' | 'lb' | 'ph' | 'al' | 'nb'>>): boolean {
  const empty = fields.filter((f) => !f.v);
  const required = empty.filter((f) => f.rq === 1);
  return (required.length > 0 ? required : empty.filter((f) => !isOptionalField(f))).length > 0;
}

/**
 * Whether the page itself, with no text from another tab behind it, justifies
 * an interaction: the one rule the providers, the service worker and the
 * content script all check before a `page`-sourced suggestion gets a chip.
 * A link click on a results page, or on any page whose own query the link
 * could answer; a Continue-like button on a form or
 * checkout once no empty field remains; a page scroll when there is more
 * below and the last accepted action was not already a scroll. Nothing else:
 * checks, sliders and selects need a stated preference, and a destructive
 * name never passes.
 */
export function pageJustifies(
  verb: InteractVerb,
  el: ElementDescriptor | undefined,
  state: PageState | undefined,
  fields: ReadonlyArray<Pick<FieldDescriptor, 'v' | 'rq' | 'lb' | 'ph' | 'al' | 'nb'>>,
): boolean {
  if (!state) return false;
  if (verb === 'scroll' && !el) return state.more && !(state.done ?? []).includes(PAGE_SCROLL_DONE);
  if (!el || verb !== 'click' || isDestructiveName(el.nm)) return false;
  if ((state.done ?? []).includes(elementKey(el.r, el.nm))) return false;
  if (el.r === 'link') return state.kind === 'serp' || (state.q ?? '') !== '';
  if (el.r === 'button') return (state.kind === 'checkout' || state.kind === 'form') && isContinueName(el.nm) && !emptyFieldRemains(fields);
  return false;
}

/**
 * The verb a bare `scroll` stands in for once the element is on-screen: the
 * one thing a button, link, tab, menu item or disclosure does, or the state
 * change a toggle is due for. Sliders and selects need a value, so nothing is
 * implied for them.
 */
export function impliedVerb(d: ElementDescriptor): Exclude<InteractVerb, 'scroll' | 'set' | 'choose'> | null {
  switch (d.r) {
    case 'button':
    case 'link':
    case 'tab':
    case 'menuitem':
    case 'disclosure':
      return 'click';
    case 'option':
      return d.sel === 1 ? null : 'click';
    case 'radio':
      return 'check';
    case 'checkbox':
    case 'switch':
      return d.st === 'on' ? 'uncheck' : 'check';
    case 'slider':
    case 'select':
      return null;
  }
}

/**
 * Whether `verb` with `value` makes sense for the element as described: the
 * role allows it, a toggle is not already in the target state, a slider value
 * is a number inside the range, a select value is one of the options listed.
 * A scroll fits any role, only while the element is off-screen, and only bare.
 */
export function verbFits(d: ElementDescriptor, verb: InteractVerb, value: string): boolean {
  if (verb === 'scroll') return isOffScreen(d) && value.trim() === '';
  if (!VERBS_BY_ROLE[d.r].includes(verb)) return false;
  switch (verb) {
    case 'check':
      return d.st !== 'on';
    case 'uncheck':
      return d.st !== 'off';
    case 'set': {
      const n = Number(value);
      if (!Number.isFinite(n)) return false;
      if (d.min !== undefined && n < d.min) return false;
      if (d.max !== undefined && n > d.max) return false;
      return true;
    }
    case 'choose':
      return d.op === undefined || d.op.some((o) => o.toLowerCase() === value.trim().toLowerCase());
    case 'click':
      // An option card that is already chosen has nothing left to click.
      return d.r !== 'option' || d.sel !== 1;
  }
}

export interface ChipText {
  verb: string; // "Set"
  value: string; // what goes in quotes: the element name, or the option for a select
  tail: string; // " to 40", or ""
}

/**
 * The words on the chip: `Click "Save"`, `Select "7:00 AM Air Canada"`, `Check "Vegetarian"`,
 * `Set "Volume" to 40`, `Choose "Canada"`, `Scroll to "Save"`, `Scroll down` for the page
 * itself; with a link's site, `Open "Order Now" on doordash.com`.
 */
export function interactionChipText(verb: InteractVerb, name: string, value: string, role?: ElementRole, site?: string): ChipText {
  switch (verb) {
    case 'click':
      if (site) return { verb: 'Open', value: name, tail: ` on ${site}` };
      return { verb: role === 'option' ? 'Select' : 'Click', value: name, tail: '' };
    case 'scroll':
      return name === '' ? { verb: 'Scroll down', value: '', tail: '' } : { verb: 'Scroll to', value: name, tail: '' };
    case 'check':
      return { verb: 'Check', value: name, tail: '' };
    case 'uncheck':
      return { verb: 'Uncheck', value: name, tail: '' };
    case 'set':
      return { verb: 'Set', value: name, tail: ` to ${value}` };
    case 'choose':
      return { verb: 'Choose', value, tail: '' };
  }
}

/** Identity of an element for suppression: what the descriptor carries, so the background can build the same key. */
export function elementKey(role: string, name: string): string {
  return `${role}|${name.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}
