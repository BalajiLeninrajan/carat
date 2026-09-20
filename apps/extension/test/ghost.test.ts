import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCEPT_KEYS } from '../src/chip/accept-key';
import { KEYCAP, KEYCAP_CSS } from '../src/chip/styles';
import { Ghost } from '../src/engine/content/ghost';

describe('the key hint at the end of ghost text', () => {
  let ghost: Ghost;
  let field: HTMLInputElement;

  beforeEach(() => {
    ghost = new Ghost();
    field = document.createElement('input');
    field.value = 'sev';
    document.body.append(field);
  });

  afterEach(() => {
    ghost.hide();
    ghost.element?.remove();
    document.body.innerHTML = '';
  });

  it('draws the key after the last glyph of the suggestion', () => {
    ghost.show(field, 'en Shores Cafe');
    const drawn = ghost.drawn;
    expect(drawn?.hint).toBe(ACCEPT_KEYS.rightShift.glyph);
    expect(drawn?.ghost).toBe('en Shores Cafe');
    // Every glyph in order: the field's own text, the suggestion, then the key.
    expect(drawn?.line).toBe(`seven Shores Cafe${ACCEPT_KEYS.rightShift.glyph}`);
  });

  it('keeps the key on the same line as the last word', () => {
    ghost.show(field, 'en Shores Cafe');
    expect(ghost.drawn?.tail).toBe(`Cafe${ACCEPT_KEYS.rightShift.glyph}`);
  });

  it('names whichever key the setting says takes the line', () => {
    ghost.show(field, 'en Shores Cafe');
    ghost.setAcceptKey('tab');
    expect(ghost.drawn?.hint).toBe(ACCEPT_KEYS.tab.glyph);
    ghost.setAcceptKey('rightShift');
    expect(ghost.drawn?.hint).toBe(ACCEPT_KEYS.rightShift.glyph);
  });

  it('draws the same key the chip does', () => {
    ghost.show(field, 'en');
    expect(KEYCAP_CSS).toContain(`border-radius: ${KEYCAP.radiusPx}px`);
    expect(KEYCAP_CSS).toContain(`font: 600 ${KEYCAP.fontPx}px/1`);
  });

  it('goes when the ghost does, whether it was taken or refused', () => {
    ghost.show(field, 'en Shores Cafe');
    expect(ghost.drawn?.hint).toBe(ACCEPT_KEYS.rightShift.glyph);
    ghost.hide();
    expect(ghost.drawn).toBeNull();

    // And the field is its own: nothing carat drew ever went into the value.
    expect(field.value).toBe('sev');
  });

  it("leaves the field's value and caret alone", () => {
    field.value = 'seven';
    field.setSelectionRange(5, 5);
    ghost.show(field, ' Shores');
    expect(field.value).toBe('seven');
    expect(field.selectionStart).toBe(5);
  });
});
