import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OutlineControl } from '@carat/shared';
import { OUTLINE_LIMITS, buildOutline } from '../src/outline';

/**
 * The widgets a booking site is made of: station pickers that put the
 * combobox role on a wrapper, date fields that are buttons opening a dialog,
 * inputs labelled from outside their own shadow root, and fields named by
 * nothing but a placeholder or a stray `<label>`. Each of these used to reach
 * the model as an unnamed box, as the wrong role, or not at all, and a model
 * with nothing it can name has nothing to answer but `scroll`.
 */

const named = (controls: readonly OutlineControl[], name: string): OutlineControl | undefined => controls.find((c) => c.name === name);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('rich form controls', () => {
  it('numbers the field inside a combobox wrapper, not just the wrapper', () => {
    document.body.innerHTML = `
      <span id="from-label">From</span>
      <div role="combobox" aria-expanded="false" aria-labelledby="from-label">
        <input id="from" placeholder="Departure station">
      </div>`;
    const { controls, outline, registry } = buildOutline(document);

    const wrapper = named(controls, 'From')!;
    expect(wrapper.role).toBe('combobox');
    const field = named(controls, 'Departure station')!;
    expect(field.role).toBe('textbox');
    // The wrapper cannot be filled; the input inside it can, and that is what the registry points at.
    expect(registry.get(field.n)?.el).toBe(document.getElementById('from'));
    expect(outline).toContain(`[${field.n}] textbox "Departure station"`);
  });

  it('never names a combobox after what has been typed into it', () => {
    document.body.innerHTML = `
      <span id="to-label">To</span>
      <div role="combobox" aria-labelledby="to-label"><input value="Mon"></div>`;
    const { controls } = buildOutline(document);
    expect(named(controls, 'To')?.value).toBeUndefined();
    expect(controls.map((c) => c.name)).not.toContain('Mon');
  });

  it('lists an expanded combobox\'s options, wherever the page keeps them', () => {
    document.body.innerHTML = `
      <div role="combobox" aria-label="To" aria-expanded="true" aria-controls="list"><input></div>
      <ul id="list" role="listbox">
        <li role="option">Montreal</li>
        <li role="option" aria-selected="true">Moncton</li>
      </ul>`;
    const { outline, controls } = buildOutline(document);
    expect(outline).toContain('combobox "To" (expanded)');
    expect(outline).toContain('option "Montreal"');
    expect(outline).toContain('option "Moncton" (selected)');
    // The list was described under the combobox that owns it, so it is not described twice.
    expect(outline.match(/option "Montreal"/g)).toHaveLength(1);
    expect(named(controls, 'Montreal Moncton')).toBeUndefined();
  });

  it('describes a date field that is really a button as one that opens a dialog', () => {
    document.body.innerHTML = '<button aria-haspopup="dialog">Departure date</button>';
    const { outline, controls } = buildOutline(document);
    expect(outline).toContain('button "Departure date" (opens dialog)');
    expect(named(controls, 'Departure date')?.popup).toBe('dialog');
  });

  it('resolves aria-labelledby out through the shadow boundary when the root has no such id', () => {
    document.body.innerHTML = '<span id="card-label">Loyalty card</span><station-picker id="picker"></station-picker>';
    const root = document.getElementById('picker')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="card" aria-labelledby="card-label">';
    const { controls } = buildOutline(document);
    expect(named(controls, 'Loyalty card')?.role).toBe('textbox');
  });

  it('names a field from the label beside it when nothing joins the two', () => {
    document.body.innerHTML = '<div><label>Discount code</label><input id="discount"></div>';
    const { controls, outline } = buildOutline(document);
    expect(named(controls, 'Discount code')?.role).toBe('textbox');
    // And the label is not also a line of prose saying the same words.
    expect(outline).not.toContain('text: Discount code');
  });

  it('names a field from its placeholder when it has nothing else', () => {
    document.body.innerHTML = '<input placeholder="Promotion code">';
    expect(named(buildOutline(document).controls, 'Promotion code')?.role).toBe('textbox');
  });

  it('reads a contenteditable search box as a searchbox with its own label', () => {
    document.body.innerHTML = '<span id="who">Travellers</span><div contenteditable="true" role="searchbox" aria-labelledby="who">2 adults</div>';
    const { controls } = buildOutline(document);
    const box = named(controls, 'Travellers')!;
    expect(box.role).toBe('searchbox');
    expect(box.value).toBe('2 adults');
  });

  it('numbers nothing decorative: a presentational role, and an anchor with nowhere to go', () => {
    document.body.innerHTML = '<div role="presentation" tabindex="-1">spacer</div><a>Not a link</a><button role="none">Still a button</button>';
    const { controls } = buildOutline(document);
    expect(controls.map((c) => c.name)).toEqual(['Still a button']);
  });
});

describe('what the outline admits it left out', () => {
  it('says how many of the page\'s controls it described when the budget cut the list short', () => {
    const rows = Array.from({ length: OUTLINE_LIMITS.maxControls + 12 }, (_, i) => `<button>Seat ${i}</button>`).join('');
    document.body.innerHTML = `<main>${rows}</main>`;
    const { outline, controls, describedControls, pageControls } = buildOutline(document);

    expect(pageControls).toBe(OUTLINE_LIMITS.maxControls + 12);
    expect(describedControls).toBe(controls.length);
    expect(describedControls).toBeLessThan(pageControls);
    expect(outline).toContain(`only ${describedControls} of ${pageControls} controls described`);
  });

  it('says nothing about a count when it described everything', () => {
    document.body.innerHTML = '<main><button>Find trains</button></main>';
    const { outline, describedControls, pageControls } = buildOutline(document);
    expect(describedControls).toBe(1);
    expect(pageControls).toBe(1);
    expect(outline).not.toContain('controls described');
  });
});

describe('the outline:dump dev script', () => {
  it('prints the booking fixture\'s widgets for a page saved from a browser', () => {
    const root = resolve(__dirname, '..');
    const out = execFileSync(
      resolve(root, 'node_modules/.bin/tsx'),
      ['scripts/outline-dump.ts', 'test/fixtures/booking.html', '--scripts'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(out).toContain('combobox "From"');
    expect(out).toContain('textbox "Departure station"');
    expect(out).toContain('button "Departure date" (opens dialog)');
    expect(out).toContain('textbox "Discount code"');
    expect(out).toContain('textbox "Loyalty card"');
    expect(out).toMatch(/\d+ of \d+ controls described/);
  }, 60_000);
});
