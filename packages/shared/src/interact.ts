import type { ElementDescriptor, ElementRole, InteractVerb } from './types';

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
  checkbox: ['check', 'uncheck'],
  switch: ['check', 'uncheck'],
  radio: ['check'],
  slider: ['set'],
  select: ['choose'],
};

export const ELEMENT_ROLES = Object.keys(VERBS_BY_ROLE) as ElementRole[];

/** Roles whose value or state another tab's text can name; a plain button only gets a chip after carat filled something. */
export const CONTROL_ROLES: ReadonlySet<ElementRole> = new Set(['checkbox', 'switch', 'radio', 'slider', 'select']);

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
      return true;
  }
}

export interface ChipText {
  verb: string; // "Set"
  value: string; // what goes in quotes: the element name, or the option for a select
  tail: string; // " to 40", or ""
}

/** The words on the chip: `Click "Save"`, `Check "Vegetarian"`, `Set "Volume" to 40`, `Choose "Canada"`, `Scroll to "Save"`. */
export function interactionChipText(verb: InteractVerb, name: string, value: string): ChipText {
  switch (verb) {
    case 'click':
      return { verb: 'Click', value: name, tail: '' };
    case 'scroll':
      return { verb: 'Scroll to', value: name, tail: '' };
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
