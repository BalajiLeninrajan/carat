import { describe, expect, it } from 'vitest';
import { echoesField, echoesPage, refusesFill } from '../src/fill-guard';

const mapsField = { nm: 'searchboxinput', ph: 'Search Google Maps', al: 'Search Google Maps' };
const mapsPage = { host: 'www.google.com', title: 'Google Maps' };

describe('echoesField', () => {
  it('catches the field reading its own descriptor back', () => {
    for (const junk of ['Search Google Maps', 'search google maps', 'Google Maps']) {
      expect(echoesField(junk, mapsField), junk).toBe(true);
    }
    expect(echoesField('Seven Shores Cafe', mapsField)).toBe(false);
    // A short `name` attribute must not swallow every value that happens to contain it.
    expect(echoesField('Pho Dau Bo', { nm: 'q' })).toBe(false);
    expect(echoesField('q', { nm: 'q' })).toBe(true);
    // A field the user already typed into is not refilled with what is in it.
    expect(echoesField('Waterloo', { v: 'Waterloo' })).toBe(true);
  });
});

describe('echoesPage', () => {
  it('catches the page title, the heading and the bare site name', () => {
    expect(echoesPage('Google Maps', mapsPage)).toBe(true);
    expect(echoesPage('google', { host: 'www.google.com', title: '' })).toBe(true);
    expect(echoesPage('fare increase', { host: 'www.cbc.ca', title: 'Region approves transit fare increase' })).toBe(true);
    expect(echoesPage('Pho Dau Bo', { host: 'www.reddit.com', title: 'Best pho in Waterloo? : r/waterloo' })).toBe(false);
  });
});

describe('refusesFill', () => {
  const cafe = 'Seven Shores Cafe';

  it('lets the page fill its own field with something somebody named on it', () => {
    expect(refusesFill(cafe, mapsField, mapsPage, true)).toBe(false);
    expect(refusesFill(cafe, mapsField, mapsPage, false)).toBe(false);
  });

  it('refuses the page furniture, an interface word and an empty value', () => {
    for (const junk of ['Google Maps', 'Search Google Maps', 'Search', 'Sign in', '   ']) {
      expect(refusesFill(junk, mapsField, mapsPage, true), junk).toBe(true);
    }
    // The page's own title only bars a value taken from that page; another tab may still say it.
    expect(refusesFill('Region approves transit fare increase', { al: 'Search CBC' }, { host: 'www.cbc.ca', title: 'Region approves transit fare increase' }, true)).toBe(true);
    expect(refusesFill('Region approves transit fare increase', { al: 'Search CBC' }, { host: 'www.cbc.ca', title: 'Region approves transit fare increase' }, false)).toBe(false);
  });
});
