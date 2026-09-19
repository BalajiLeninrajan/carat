import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fillContentEditable,
  fillElement,
  fillSelect,
  fillTextControl,
  resolveTarget,
} from '../src/fill';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;

describe('fillTextControl', () => {
  it('writes through the prototype setter on a React-style tracked input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    // React's inputValueTracking: an own `value` accessor shadowing the native one.
    const tracker = { set: vi.fn(), current: '' };
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => tracker.current,
      set: (v: string) => {
        tracker.set(v);
        tracker.current = v;
      },
    });

    const events: string[] = [];
    let inputType = '';
    input.addEventListener('input', (e) => {
      events.push('input');
      inputType = (e as InputEvent).inputType;
    });
    input.addEventListener('change', () => events.push('change'));

    fillTextControl(input, 'Seven Shores Cafe');

    expect(nativeValue.get!.call(input)).toBe('Seven Shores Cafe');
    expect(tracker.set).not.toHaveBeenCalled();
    expect(events).toEqual(['input', 'change']);
    expect(inputType).toBe('insertText');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe('Seven Shores Cafe'.length);
  });

  it('fills a textarea and survives inputs without selection support', () => {
    const ta = document.createElement('textarea');
    const email = document.createElement('input');
    email.type = 'email';
    document.body.append(ta, email);

    fillTextControl(ta, 'hello');
    expect(ta.value).toBe('hello');
    expect(() => fillTextControl(email, 'a@b.co')).not.toThrow();
    expect(email.value).toBe('a@b.co');
  });
});

describe('fillContentEditable', () => {
  it('falls back to beforeinput + text node when execCommand is missing', () => {
    expect(typeof document.execCommand).toBe('undefined');
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    document.body.appendChild(ce);
    const seen: string[] = [];
    ce.addEventListener('beforeinput', (e) => {
      seen.push('beforeinput');
      expect(e.cancelable).toBe(true);
    });
    ce.addEventListener('input', () => seen.push('input'));

    fillContentEditable(ce, 'Seven Shores Cafe');

    expect(ce.textContent).toBe('Seven Shores Cafe');
    expect(seen).toEqual(['beforeinput', 'input']);
  });

  it('falls back when execCommand returns false and appends after existing text', () => {
    const exec = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', '');
    ce.textContent = 'dinner at ';
    document.body.appendChild(ce);

    fillContentEditable(ce, 'Seven Shores Cafe');

    expect(exec).toHaveBeenCalledWith('insertText', false, 'Seven Shores Cafe');
    expect(ce.textContent).toBe('dinner at Seven Shores Cafe');
    delete (document as { execCommand?: unknown }).execCommand;
  });

  it('leaves the DOM alone when an editor cancels beforeinput', () => {
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    document.body.appendChild(ce);
    ce.addEventListener('beforeinput', (e) => e.preventDefault());
    const onInput = vi.fn();
    ce.addEventListener('input', onInput);

    fillContentEditable(ce, 'x');

    expect(ce.textContent).toBe('');
    expect(onInput).not.toHaveBeenCalled();
  });
});

describe('fillSelect', () => {
  it('matches by value, then by option text', () => {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">--</option><option value="ca">Canada</option>';
    document.body.appendChild(sel);
    const onChange = vi.fn();
    sel.addEventListener('change', onChange);

    expect(fillSelect(sel, 'ca')).toBe(true);
    expect(sel.value).toBe('ca');
    expect(fillSelect(sel, 'canada')).toBe(true);
    expect(fillSelect(sel, 'Mars')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('fillElement', () => {
  it('dispatches by element kind and descends into combobox wrappers', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('role', 'combobox');
    const inner = document.createElement('input');
    wrapper.appendChild(inner);
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    const plain = document.createElement('div');
    document.body.append(wrapper, ce, plain);

    expect(fillElement(wrapper, 'a', 'example.com')).toBe(true);
    expect(inner.value).toBe('a');
    expect(fillElement(ce, 'b', 'example.com')).toBe(true);
    expect(ce.textContent).toBe('b');
    expect(fillElement(plain, 'c', 'example.com')).toBe(false);
  });

  it('runs the calendar adapter postFill on time-like fields only', () => {
    const time = document.createElement('input');
    time.setAttribute('aria-label', 'Start time');
    const title = document.createElement('input');
    title.setAttribute('aria-label', 'Add title');
    document.body.append(time, title);
    const keys: string[] = [];
    for (const el of [time, title]) {
      el.addEventListener('keydown', (e) => keys.push(`${el.ariaLabel}:down:${e.key}`));
      el.addEventListener('keyup', (e) => keys.push(`${el.ariaLabel}:up:${e.key}`));
    }

    fillElement(time, '6:00pm', 'calendar.google.com');
    fillElement(title, 'Dinner', 'calendar.google.com');

    expect(keys).toEqual(['Start time:down:Enter', 'Start time:up:Enter']);
  });
});

describe('resolveTarget', () => {
  it('prefers the adapter selector when present, else the registry element', () => {
    const decoy = document.createElement('input');
    const real = document.createElement('input');
    real.id = 'searchboxinput';
    document.body.append(decoy, real);

    expect(resolveTarget('maps.google.com', decoy, '/')).toBe(real);
    expect(resolveTarget('www.google.com', decoy, '/maps/place/x')).toBe(real);
    expect(resolveTarget('example.com', decoy, '/')).toBe(decoy);

    real.remove();
    const fallback = document.createElement('input');
    fallback.setAttribute('aria-label', 'Search Google Maps');
    document.body.appendChild(fallback);
    expect(resolveTarget('maps.google.com', decoy, '/')).toBe(fallback);

    fallback.remove();
    expect(resolveTarget('maps.google.com', decoy, '/')).toBe(decoy);
  });

  it('never redirects away from the field the user is focused in', () => {
    const focused = document.createElement('input');
    const real = document.createElement('input');
    real.id = 'searchboxinput';
    document.body.append(focused, real);
    focused.focus();
    expect(resolveTarget('maps.google.com', focused, '/')).toBe(focused);
  });
});
