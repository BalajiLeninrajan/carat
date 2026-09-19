import { describe, expect, it } from 'vitest';
import type { NextActionRequest, OutlineControl } from '@carat/shared';
import { LocalProvider, localAction } from '../src/local';

const request = (controls: OutlineControl[], over: Partial<NextActionRequest> = {}): NextActionRequest => ({
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps', scroll: { y: 0, pages: 1, more: false } },
  outline: 'search:',
  controls,
  history: [],
  notes: ['Alex proposed dinner at Seven Shores Cafe on Friday at 6.'],
  tabs: [],
  now: '2026-09-16T14:04:00-04:00',
  eagerness: 'eager',
  allowPayments: false,
  ...over,
});

describe('the offline placeholder', () => {
  it('puts a place from the notes in the focused search box', () => {
    const action = localAction(request([{ n: 1, role: 'searchbox', name: 'Search Google Maps' }], { focused: 1 }));
    expect(action).toMatchObject({ kind: 'fill', target: 1, value: 'Seven Shores Cafe', irreversible: false });
    expect(action.label).toBe('Fill Search Google Maps with "Seven Shores Cafe"');
  });

  it('falls back to the first empty text control when nothing is focused', () => {
    const action = localAction(
      request([
        { n: 1, role: 'button', name: 'Directions' },
        { n: 2, role: 'searchbox', name: 'Search Google Maps' },
      ]),
    );
    expect(action.target).toBe(2);
  });

  it('leaves a control that already has a value alone', () => {
    const action = localAction(request([{ n: 1, role: 'searchbox', name: 'Search', value: 'brunch' }], { focused: 1 }));
    expect(action.kind).toBe('none');
  });

  it('matches the value to what the control asks for', () => {
    const controls: OutlineControl[] = [
      { n: 1, role: 'textbox', name: 'Add location' },
      { n: 2, role: 'textbox', name: 'Add title' },
    ];
    const notes = ['Seven Shores Cafe is at 10 Regina St N, Waterloo, ON N2J 2Z8.'];
    expect(localAction(request(controls, { notes, focused: 1 })).value).toBe('10 Regina St N, Waterloo, ON N2J 2Z8');
    expect(localAction(request(controls, { notes, focused: 2 })).value).toBe('Seven Shores Cafe');
  });

  it('never types into a payment or secret field', () => {
    const notes = ["Priya's number is (519) 555-0142."];
    const action = localAction(request([{ n: 1, role: 'textbox', name: 'Card number', state: 'required' }], { notes, focused: 1 }));
    expect(action.kind).toBe('none');
  });

  it('never types into a control flagged risky', () => {
    const action = localAction(request([{ n: 1, role: 'textbox', name: 'Search', risky: true }], { focused: 1 }));
    expect(action.kind).toBe('none');
  });

  it('never types a control its own name back into it', () => {
    const action = localAction(request([{ n: 1, role: 'searchbox', name: 'Seven Shores Cafe' }], { focused: 1 }));
    expect(action.value).not.toBe('Seven Shores Cafe');
    const onlyEcho = localAction(
      request([{ n: 1, role: 'searchbox', name: 'Seven Shores Cafe' }], {
        focused: 1,
        notes: ['Seven Shores Cafe is the place.'],
      }),
    );
    expect(onlyEcho.kind).toBe('none');
  });

  it('has no page-kind rules: an article with nothing read gets nothing', () => {
    const action = localAction(
      request([{ n: 1, role: 'link', name: 'Read more', host: 'cbc.ca' }], {
        notes: [],
        page: { host: 'www.cbc.ca', title: 'News', path: '/news', scroll: { y: 0.4, pages: 4, more: true } },
      }),
    );
    expect(action.kind).toBe('none');
  });

  it('answers nothing once the signal has fired', async () => {
    const provider = new LocalProvider();
    expect(await provider.next(request([]), { signal: AbortSignal.abort() })).toBeNull();
  });
});
