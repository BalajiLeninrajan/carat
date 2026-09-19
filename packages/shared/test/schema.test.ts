import { describe, expect, it } from 'vitest';
import {
  NEXT_ACTION_JSON_SCHEMA,
  isIrreversibleLabel,
  isMoneyLabel,
  parseNextAction,
  partialTarget,
  salvageNextAction,
} from '../src/schema';

const whole = JSON.stringify({
  target: 3,
  kind: 'click',
  value: '',
  label: 'Click "Order online"',
  irreversible: false,
  confidence: 0.64,
  reason: 'the first result answers the query',
});

describe('the next-action schema', () => {
  it('lists target first, so the chip can move before the label arrives', () => {
    expect(Object.keys(NEXT_ACTION_JSON_SCHEMA.properties)[0]).toBe('target');
    expect(NEXT_ACTION_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(NEXT_ACTION_JSON_SCHEMA.required).toEqual(Object.keys(NEXT_ACTION_JSON_SCHEMA.properties));
  });

  it('parses a whole answer', () => {
    const parsed = parseNextAction(whole);
    expect(parsed.ok && parsed.action.kind).toBe('click');
    expect(parsed.ok && parsed.action.target).toBe(3);
  });

  it('parses an answer in a fenced block, and fills in what a loose model left out', () => {
    const parsed = parseNextAction('```json\n{"kind":"scroll","target":null}\n```');
    expect(parsed.ok && parsed.action).toEqual({
      kind: 'scroll',
      target: null,
      value: '',
      label: '',
      irreversible: false,
      confidence: 0.5,
      reason: '',
    });
  });

  it('refuses an unknown kind', () => {
    expect(parseNextAction('{"kind":"teleport","target":1}').ok).toBe(false);
  });

  it('reads the target out of a partial body as soon as the integer is closed', () => {
    expect(partialTarget('{"target":')).toBeNull();
    expect(partialTarget('{"target":12')).toBeNull();
    expect(partialTarget('{"target":12,')).toBe(12);
    expect(partialTarget('{"target":null,')).toBeNull();
  });

  it('salvages a body cut off inside a long value, trimming to the last whole sentence', () => {
    const cut = '{"target":2,"kind":"fill","value":"Thanks for confirming. Since all three are on 3.2.0.47';
    const action = salvageNextAction(cut);
    expect(action).not.toBeNull();
    expect(action!.kind).toBe('fill');
    expect(action!.target).toBe(2);
    expect(action!.value).toBe('Thanks for confirming.');
  });

  it('salvages a body cut off after the value, keeping the label it did get', () => {
    const cut = '{"target":5,"kind":"click","value":"","label":"Checkout","irreversible":true,"confi';
    const action = salvageNextAction(cut)!;
    expect(action.label).toBe('Checkout');
    expect(action.irreversible).toBe(true);
    expect(action.confidence).toBe(0.5);
  });

  it('gives up when even the kind never arrived', () => {
    expect(salvageNextAction('{"target":1,"ki')).toBeNull();
  });

  it('parseNextAction falls back to the salvage reader on truncated JSON', () => {
    const parsed = parseNextAction('{"target":5,"kind":"click","value":"","label":"Chec');
    expect(parsed.ok && parsed.action.target).toBe(5);
  });

  it('knows the labels that cannot be undone and the ones that move money', () => {
    expect(isIrreversibleLabel('Send reply')).toBe(true);
    expect(isIrreversibleLabel('Place order')).toBe(true);
    expect(isIrreversibleLabel('Open "Seven Shores Cafe menu"')).toBe(false);
    expect(isMoneyLabel('Pay $312.40')).toBe(true);
    expect(isMoneyLabel('Book now')).toBe(true);
    expect(isMoneyLabel('Save')).toBe(false);
  });
});
