import { describe, expect, it } from 'vitest';
import { EAGERNESS_LEVELS } from '../src/eagerness';
import { CONTROL_ROLES, ELEMENT_ROLES, VERBS_BY_ROLE, clickAllowed, elementKey, impliedVerb, interactionChipText, isElementRole, isInteractVerb, isOffScreen, isPrimaryActionName, verbFits } from '../src/interact';
import type { ClickGate } from '../src/interact';
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
    expect(isInteractVerb('scroll')).toBe(true);
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

  it('lets a bare scroll fit any role, but only an off-screen element', () => {
    for (const r of ELEMENT_ROLES) expect(verbFits(el({ r, o: 1 }), 'scroll', '')).toBe(true);
    expect(verbFits(el({ o: 1 }), 'scroll', 'Save')).toBe(false);
    expect(verbFits(el({}), 'scroll', '')).toBe(false);
    expect(isOffScreen(el({ o: 1 }))).toBe(true);
    expect(isOffScreen(el({}))).toBe(false);
  });
});

describe('option cards', () => {
  it('take a click unless already chosen, and count as controls another tab can name', () => {
    expect(verbFits(el({ r: 'option', nm: '7:00 AM Air Canada' }), 'click', '7:00 AM Air Canada')).toBe(true);
    expect(verbFits(el({ r: 'option', nm: '7:00 AM Air Canada', sel: 1 }), 'click', '7:00 AM Air Canada')).toBe(false);
    expect(verbFits(el({ r: 'option' }), 'check', 'x')).toBe(false);
    expect(impliedVerb(el({ r: 'option' }))).toBe('click');
    expect(impliedVerb(el({ r: 'option', sel: 1 }))).toBeNull();
    expect(CONTROL_ROLES.has('option')).toBe(true);
    expect(interactionChipText('click', 'Basic fare $312', 'Basic fare $312', 'option')).toEqual({ verb: 'Select', value: 'Basic fare $312', tail: '' });
  });
});

describe('isPrimaryActionName', () => {
  it.each(['Search', 'Continue', 'Next', 'Select flight', 'Choose', 'Proceed', 'Continue to payment', 'Review trip', 'Book', 'Apply', 'Done', 'Save', 'Create', 'Confirm details', 'Find flights', 'Get started'])(
    'accepts %j',
    (name) => expect(isPrimaryActionName(name)).toBe(true),
  );
  // Money names never count as continue-style, even when they start with a continue word.
  it.each(['Confirm', 'Pay', 'Book now', 'Proceed to checkout', 'Cancel', 'Close', 'More options', 'Searching for something else entirely on this very long button', '', 'Selected'])(
    'rejects %j',
    (name) => expect(isPrimaryActionName(name)).toBe(false),
  );
});

describe('clickAllowed', () => {
  const gate = (over: Partial<ClickGate> = {}): ClickGate => ({ filled: false, flow: false, eagerness: 'eager', fillable: false, ...over });
  const primary = el({ nm: 'Continue', p: 1 });

  it('lets any button through after a fill, at every level', () => {
    for (const eagerness of EAGERNESS_LEVELS) {
      expect(clickAllowed(el({ nm: 'More options' }), gate({ filled: true, eagerness, fillable: true }))).toBe(true);
    }
  });

  it('without a fill wants the primary action with a continue-style name', () => {
    expect(clickAllowed(el({ nm: 'Continue' }), gate())).toBe(false);
    expect(clickAllowed(el({ nm: 'More options', p: 1 }), gate())).toBe(false);
    expect(clickAllowed(primary, gate())).toBe(true);
  });

  it('follows the level when no flow is under way: eager only, and only with nothing left to fill', () => {
    expect(clickAllowed(primary, gate({ eagerness: 'eager', fillable: false }))).toBe(true);
    expect(clickAllowed(primary, gate({ eagerness: 'eager', fillable: true }))).toBe(false);
    expect(clickAllowed(primary, gate({ eagerness: 'balanced' }))).toBe(false);
    expect(clickAllowed(primary, gate({ eagerness: 'conservative' }))).toBe(false);
  });

  it('lets a flow open the primary action at every level, fields or not', () => {
    for (const eagerness of EAGERNESS_LEVELS) {
      expect(clickAllowed(primary, gate({ flow: true, eagerness, fillable: true }))).toBe(true);
      expect(clickAllowed(el({ nm: 'More options', p: 1 }), gate({ flow: true, eagerness }))).toBe(false);
    }
  });

  it('never gates roles other than button and link', () => {
    expect(clickAllowed(el({ r: 'option', nm: 'Basic' }), gate({ eagerness: 'conservative' }))).toBe(true);
    expect(clickAllowed(el({ r: 'checkbox', nm: 'All day' }), gate({ eagerness: 'conservative' }))).toBe(true);
    expect(clickAllowed(el({ r: 'link', nm: 'Continue' }), gate({ eagerness: 'conservative' }))).toBe(false);
  });
});

describe('impliedVerb', () => {
  it('names the one thing a button or toggle does, and nothing for a slider or select', () => {
    expect(impliedVerb(el({}))).toBe('click');
    expect(impliedVerb(el({ r: 'disclosure', st: 'closed' }))).toBe('click');
    expect(impliedVerb(el({ r: 'radio', st: 'off' }))).toBe('check');
    expect(impliedVerb(el({ r: 'checkbox', st: 'off' }))).toBe('check');
    expect(impliedVerb(el({ r: 'switch', st: 'on' }))).toBe('uncheck');
    expect(impliedVerb(el({ r: 'slider' }))).toBeNull();
    expect(impliedVerb(el({ r: 'select' }))).toBeNull();
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
