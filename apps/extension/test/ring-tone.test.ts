import { afterEach, describe, expect, it } from 'vitest';
import { RING, Ring, toneBehind } from '../src/engine/content/ring';

afterEach(() => {
  document.body.replaceChildren();
  document.body.style.cssText = '';
  document.documentElement.style.cssText = '';
});

describe('the ring reads the page behind its target', () => {
  it('is light on a page that paints nothing', () => {
    const input = document.createElement('input');
    document.body.append(input);
    expect(toneBehind(input)).toBe('light');
  });

  it('is dark inside a dark panel, whatever the page around it', () => {
    const panel = document.createElement('div');
    panel.style.backgroundColor = '#1e1e2e';
    const input = document.createElement('input');
    panel.append(input);
    document.body.append(panel);
    expect(toneBehind(input)).toBe('dark');
  });

  it('is light inside a white card on a dark page', () => {
    document.body.style.backgroundColor = 'rgb(17, 17, 27)';
    const card = document.createElement('div');
    card.style.backgroundColor = 'rgb(255, 255, 255)';
    const input = document.createElement('input');
    card.append(input);
    document.body.append(card);
    expect(toneBehind(input)).toBe('light');
  });

  it('sees through a transparent wrapper to the dark page below', () => {
    document.body.style.backgroundColor = 'rgb(30, 30, 46)';
    const wrap = document.createElement('div');
    wrap.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    const input = document.createElement('input');
    wrap.append(input);
    document.body.append(wrap);
    expect(toneBehind(input)).toBe('dark');
  });

  it('follows a dark colour scheme when nothing is painted', () => {
    document.documentElement.style.colorScheme = 'dark';
    const input = document.createElement('input');
    document.body.append(input);
    expect(toneBehind(input)).toBe('dark');
  });

  it('has a red for an armed control, and it is the only colour armed changes', () => {
    // The pill does not change at all; the ring alone turns red.
    expect(RING.alarm).toBe('#f38ba8');
    expect(RING.onLight.alarm).toBe('#d20f39');
    expect(RING.alarm).not.toBe(RING.armed);
    expect(RING.onLight.alarm).not.toBe(RING.onLight.armed);
    const red = (hex: string): boolean => {
      const at = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
      return at(1) > at(3) && at(1) > at(5);
    };
    expect([red(RING.alarm), red(RING.onLight.alarm)]).toEqual([true, true]);
  });

  it('picks the palette when it goes on, and keeps the two apart', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const ring = new Ring();
    ring.show(input);
    expect(ring.toneShown).toBe('light');
    ring.hide();
    expect(RING.onLight.accent).not.toBe(RING.accent);
    expect(RING.onLight.armed).not.toBe(RING.armed);
  });
});
