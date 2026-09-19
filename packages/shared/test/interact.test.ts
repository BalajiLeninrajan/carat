import { describe, expect, it } from 'vitest';
import { CONTROL_ROLES, ELEMENT_ROLES, VERBS_BY_ROLE, elementKey, interactionChipText, isElementRole, isInteractVerb, verbFits } from '../src/interact';
import type { ElementDescriptor } from '../src/types';

const el = (over: Partial<ElementDescriptor>): ElementDescriptor => ({ i: 'e0', r: 'button', nm: 'Save', ...over });

describe('roles and verbs', () => {
  it('lists every role once and gives each at least one verb', () => {
    expect(new Set(ELEMENT_ROLES).size).toBe(ELEMENT_ROLES.length);
    for (const r of ELEMENT_ROLES) expect(VERBS_BY_ROLE[r].length).toBeGreaterThan(0);
    for (const r of CONTROL_ROLES) expect(ELEMENT_ROLES).toContain(r);
    expect(CONTROL_ROLES.has('button')).toBe(false);
  });

  it('recognises roles and verbs by name only', () => {
    expect(isElementRole('slider')).toBe(true);
    expect(isElementRole('listbox')).toBe(false);
    expect(isInteractVerb('set')).toBe(true);
    expect(isInteractVerb('toggle')).toBe(false);
  });
});

describe('verbFits', () => {
  it('allows only the role\'s verbs', () => {
    expect(verbFits(el({}), 'click', 'Save')).toBe(true);
    expect(verbFits(el({}), 'check', 'Save')).toBe(false);
    expect(verbFits(el({ r: 'slider', min: 0, max: 100 }), 'click', '40')).toBe(false);
    expect(verbFits(el({ r: 'radio', st: 'off' }), 'uncheck', 'x')).toBe(false);
  });

  it('never repeats a state a toggle already has', () => {
    expect(verbFits(el({ r: 'checkbox', st: 'off' }), 'check', 'Vegetarian')).toBe(true);
    expect(verbFits(el({ r: 'checkbox', st: 'on' }), 'check', 'Vegetarian')).toBe(false);
    expect(verbFits(el({ r: 'switch', st: 'on' }), 'uncheck', 'Dark mode')).toBe(true);
    expect(verbFits(el({ r: 'switch', st: 'off' }), 'uncheck', 'Dark mode')).toBe(false);
  });

  it('keeps slider values numeric and inside the range', () => {
    const vol = el({ r: 'slider', nm: 'Volume', min: 0, max: 100, step: 1 });
    expect(verbFits(vol, 'set', '40')).toBe(true);
    expect(verbFits(vol, 'set', '140')).toBe(false);
    expect(verbFits(vol, 'set', '-1')).toBe(false);
    expect(verbFits(vol, 'set', 'loud')).toBe(false);
    expect(verbFits(el({ r: 'slider' }), 'set', '7')).toBe(true);
  });

  it('keeps a select value among the listed options', () => {
    const sel = el({ r: 'select', nm: 'Show as', op: ['Busy', 'Free'] });
    expect(verbFits(sel, 'choose', 'free')).toBe(true);
    expect(verbFits(sel, 'choose', 'Tentative')).toBe(false);
    expect(verbFits(el({ r: 'select' }), 'choose', 'anything')).toBe(true);
  });
});

describe('interactionChipText', () => {
  it('reads as a question about one element', () => {
    expect(interactionChipText('click', 'Save', 'Save')).toEqual({ verb: 'Click', value: 'Save', tail: '' });
    expect(interactionChipText('check', 'Vegetarian', 'Vegetarian')).toEqual({ verb: 'Check', value: 'Vegetarian', tail: '' });
    expect(interactionChipText('uncheck', 'All day', 'All day')).toEqual({ verb: 'Uncheck', value: 'All day', tail: '' });
    expect(interactionChipText('set', 'Volume', '40')).toEqual({ verb: 'Set', value: 'Volume', tail: ' to 40' });
    expect(interactionChipText('choose', 'Show as', 'Free')).toEqual({ verb: 'Choose', value: 'Free', tail: '' });
  });
});

describe('elementKey', () => {
  it('folds case and whitespace so the background and the content script agree', () => {
    expect(elementKey('button', '  Save  event ')).toBe('button|save event');
    expect(elementKey('checkbox', 'Vegetarian')).toBe(elementKey('checkbox', 'VEGETARIAN'));
  });
});
