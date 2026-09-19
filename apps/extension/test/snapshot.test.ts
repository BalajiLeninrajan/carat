import { beforeEach, describe, expect, it } from 'vitest';
import type { FieldDescriptor } from '@carat/shared';
import { fingerprintMatchesDescriptor } from '../src/background';
import { enumerateFields, fingerprintOf, serializeFields } from '../src/snapshot';

function lay(el: Element, width: number, top = 100, height = 32): void {
  el.getBoundingClientRect = () => new DOMRect(0, top, width, height);
}

function layAll(width = 200): void {
  for (const el of document.querySelectorAll('input,textarea,[contenteditable],[role]')) lay(el, width);
}

const byId = (descriptors: FieldDescriptor[], id: string) => descriptors.find((d) => d.nm === id);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('enumerateFields', () => {
  it('describes a labelled fixture and skips hidden, password and filled fields', () => {
    document.body.innerHTML = `
      <h2>Contact details</h2>
      <label for="email">Email address</label>
      <input id="email" type="email" autocomplete="email" placeholder="you@example.com">
      <label>Phone <input id="phone" type="tel"></label>
      <input id="ariad" aria-labelledby="l1 l2"><span id="l1">Event</span> <span id="l2">title</span>
      <input id="desc" aria-describedby="d1"><span id="d1">Where is it?</span>
      <input id="hidden" type="hidden">
      <input id="pw" type="password">
      <input id="gone" style="display:none">
      <input id="filled" value="already typed">
      <input id="disabled" disabled>
      <input id="ro" readonly>
      <div aria-hidden="true"><input id="inhidden"></div>
      <div id="note" contenteditable="true" aria-label="Add a note"></div>
      <div id="searchbox"><input id="searchboxinput" role="combobox" aria-label="Search Google Maps" autocomplete="off"></div>
      <div role="combobox" id="wrapper"><input id="inner" placeholder="City"></div>
      <textarea id="msg" name="message"></textarea>
    `;
    layAll();
    const { descriptors, registry } = enumerateFields(document);
    const ids = descriptors.map((d) => d.nm);

    expect(ids).toEqual(expect.arrayContaining(['email', 'phone', 'ariad', 'desc', 'note', 'searchboxinput', 'inner', 'message']));
    for (const gone of ['hidden', 'pw', 'gone', 'filled', 'disabled', 'ro', 'inhidden', 'wrapper']) {
      expect(ids).not.toContain(gone);
    }

    const email = byId(descriptors, 'email')!;
    expect(email).toMatchObject({ t: 'input:email', lb: 'Email address', ph: 'you@example.com', ac: 'email', w: 'm' });
    expect(email.nb).toBe('Contact details');
    expect(byId(descriptors, 'phone')!.lb).toBe('Phone');
    expect(byId(descriptors, 'ariad')!.lb).toBe('Event title');
    expect(byId(descriptors, 'desc')!.lb).toBe('Where is it?');
    expect(byId(descriptors, 'note')).toMatchObject({ t: 'ce', al: 'Add a note' });
    expect(byId(descriptors, 'searchboxinput')).toMatchObject({ t: 'combobox', al: 'Search Google Maps', ac: 'off' });
    expect(byId(descriptors, 'message')!.t).toBe('textarea');
    expect(descriptors.some((d) => 'v' in d)).toBe(false);

    for (const d of descriptors) {
      const entry = registry.get(d.i)!;
      expect(entry.el.getAttribute('data-carat-id')).toBe(d.i);
      expect(entry.fingerprint).toBe(fingerprintOf(entry.el));
    }
    expect(registry.get('f0')!.el).toBe(descriptors[0] && document.querySelector(`[data-carat-id="f0"]`));
  });

  it('ranks the focused field first, then by width, then DOM order', () => {
    document.body.innerHTML = `
      <input id="narrow"><input id="wide"><input id="focused" value="typing"><input id="mid"><input id="mid2">
    `;
    lay(document.getElementById('narrow')!, 100);
    lay(document.getElementById('wide')!, 600);
    lay(document.getElementById('focused')!, 50);
    lay(document.getElementById('mid')!, 300);
    lay(document.getElementById('mid2')!, 300);
    document.getElementById('focused')!.focus();

    const { descriptors } = enumerateFields(document);
    expect(descriptors.map((d) => d.nm)).toEqual(['focused', 'wide', 'mid', 'mid2', 'narrow']);
    expect(descriptors.map((d) => d.i)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(descriptors[0]).toMatchObject({ f: 1, v: 'typing', w: 's' });
    expect(descriptors[1]!.w).toBe('l');
    expect(descriptors[1]!.f).toBeUndefined();
  });

  it('skips buttons and selects that carry text roles, and inert subtrees', () => {
    document.body.innerHTML = `
      <button id="trigger" role="combobox"></button>
      <select id="sel" role="combobox"></select>
      <a id="link" role="textbox" href="#"></a>
      <div inert><input id="behind"></div>
      <div id="real" role="textbox" contenteditable="true"></div>
      <input id="plain">
    `;
    layAll();
    expect(enumerateFields(document).descriptors.map((d) => d.nm)).toEqual(['real', 'plain']);
  });

  it('caps at 12 fields', () => {
    document.body.innerHTML = Array.from({ length: 20 }, (_, i) => `<input id="i${i}">`).join('');
    layAll();
    const { descriptors, registry } = enumerateFields(document);
    expect(descriptors).toHaveLength(12);
    expect(registry.size).toBe(12);
    expect(document.querySelectorAll('[data-carat-id]')).toHaveLength(12);
  });

  it('skips fields outside the vertical window', () => {
    document.body.innerHTML = '<input id="above"><input id="near"><input id="far">';
    const vh = window.innerHeight;
    lay(document.getElementById('above')!, 200, -vh - 1);
    lay(document.getElementById('near')!, 200, 2 * vh);
    lay(document.getElementById('far')!, 200, 2 * vh + 1);
    expect(enumerateFields(document).descriptors.map((d) => d.nm)).toEqual(['near']);
  });

  it('clears stale ids from a previous enumeration', () => {
    document.body.innerHTML = '<input id="a"><input id="b">';
    layAll();
    enumerateFields(document);
    (document.getElementById('a') as HTMLInputElement).value = 'now filled';
    const { descriptors } = enumerateFields(document);
    expect(descriptors.map((d) => d.nm)).toEqual(['b']);
    expect(document.getElementById('a')!.hasAttribute('data-carat-id')).toBe(false);
    expect(document.getElementById('b')!.getAttribute('data-carat-id')).toBe('f0');
  });

  it('keeps descriptors and registry within the byte budget', () => {
    document.body.innerHTML = Array.from(
      { length: 12 },
      (_, i) => `<input id="field${i}" placeholder="${'p'.repeat(60)}" aria-label="${'a'.repeat(60)}"><span>${'n'.repeat(80)}</span>`,
    ).join('');
    layAll();
    const { descriptors, registry } = enumerateFields(document);
    expect(descriptors.length).toBeLessThan(12);
    expect(descriptors.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(descriptors)).byteLength).toBeLessThanOrEqual(2048);
    expect(registry.size).toBe(descriptors.length);
    expect(document.querySelectorAll('[data-carat-id]')).toHaveLength(descriptors.length);
  });
});

describe('serializeFields', () => {
  it('drops the lowest ranked descriptors until the JSON fits 2048 bytes', () => {
    const big: FieldDescriptor[] = Array.from({ length: 12 }, (_, i) => ({
      i: `f${i}`,
      t: 'input:text',
      nb: 'x'.repeat(80),
      ph: 'y'.repeat(60),
      lb: 'z'.repeat(60),
    }));
    const { json, descriptors } = serializeFields(big);
    expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(2048);
    expect(descriptors.length).toBeLessThan(12);
    expect(descriptors).toEqual(big.slice(0, descriptors.length));
    expect(JSON.parse(json)).toEqual(descriptors);
  });

  it('counts bytes, not characters', () => {
    const wide: FieldDescriptor[] = [{ i: 'f0', t: 'ce', nb: '字'.repeat(700) }];
    expect(serializeFields(wide).descriptors).toEqual([]);
  });
});

describe('fingerprintOf', () => {
  it('joins tag, type, name, id, placeholder and aria-label', () => {
    document.body.innerHTML = '<input type="search" name="q" id="searchboxinput" placeholder="Search" aria-label="Search Google Maps">';
    expect(fingerprintOf(document.querySelector('input')!)).toBe('input|search|q|searchboxinput|Search|Search Google Maps');
    document.body.innerHTML = '<div contenteditable="true" id="note"></div>';
    expect(fingerprintOf(document.querySelector('div')!)).toBe('div||' + '|note||');
  });

  it.each([
    ['placeholder', '<input id="composer" placeholder="Message #design">'],
    ['aria-placeholder', '<div id="composer" contenteditable="true" aria-placeholder="Message #design"></div>'],
    ['data-placeholder', '<div id="composer" contenteditable="true" class="ql-editor" data-placeholder="Message #design"></div>'],
    ['none', '<div id="composer" contenteditable="true"></div>'],
  ])('round-trips through fingerprintMatchesDescriptor for %s', (_, html) => {
    document.body.innerHTML = html;
    layAll();
    const { descriptors, registry } = enumerateFields(document);
    expect(descriptors).toHaveLength(1);
    const d = descriptors[0]!;
    expect(fingerprintMatchesDescriptor(registry.get(d.i)!.fingerprint, d)).toBe(true);
  });
});
