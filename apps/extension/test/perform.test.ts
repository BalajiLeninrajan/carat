import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATE_TIMING, PICK_TIMING, findCell, formatDate, isDateField, isPickCombobox, matchOption, parseDate, performFill, pickFromCalendar, pickFromListbox } from '../src/fill';
import { cardAround, performInteraction, stillFits } from '../src/interact';

function lay(el: Element, width = 120, top = 100, height = 32, left = 0): void {
  el.getBoundingClientRect = () => new DOMRect(left, top, width, height);
}
function layAll(width = 120, top = 100): void {
  for (const el of document.querySelectorAll('button,input,select,a,summary,li,div,[role]')) lay(el, width, top);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('open-then-pick comboboxes', () => {
  function combobox(): HTMLInputElement {
    document.body.innerHTML = `
      <label for="from">Where from?</label>
      <input id="from" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="from-list" autocomplete="off">
      <div id="from-list" role="listbox" hidden></div>
    `;
    return document.getElementById('from') as HTMLInputElement;
  }
  /** The page reacts to typing the way an autocomplete does: after a beat, the list fills and shows. */
  function pageOpensList(input: HTMLInputElement, options: string[], afterMs = 120): void {
    input.addEventListener('input', () => {
      setTimeout(() => {
        const list = document.getElementById('from-list')!;
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        list.innerHTML = options.map((o) => `<div role="option" tabindex="-1">${o}</div>`).join('');
        for (const opt of list.querySelectorAll('[role=option]')) {
          opt.addEventListener('click', () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(input, opt.textContent ?? '');
            list.hidden = true;
            input.setAttribute('aria-expanded', 'false');
          });
        }
      }, afterMs);
    });
  }

  it('recognises a combobox that opens a list, and not a text box merely wearing the role', () => {
    const input = combobox();
    expect(isPickCombobox(input)).toBe(true);
    const plain = document.createElement('input');
    plain.setAttribute('role', 'combobox');
    expect(isPickCombobox(plain)).toBe(false);
    plain.setAttribute('aria-haspopup', 'listbox');
    expect(isPickCombobox(plain)).toBe(true);
    const wrapped = document.createElement('div');
    wrapped.setAttribute('role', 'combobox');
    wrapped.setAttribute('aria-expanded', 'false');
    const inner = document.createElement('input');
    wrapped.append(inner);
    expect(isPickCombobox(inner)).toBe(true);
  });

  it('types the value, waits for the list the control points at, and clicks the first option that starts with it', async () => {
    const input = combobox();
    pageOpensList(input, ['Toronto Island (YTZ)', 'Toronto Pearson International (YYZ)', 'Torrance']);
    const done = performFill(input, 'Toronto Pearson', 'www.google.com');
    await tick(0);
    expect(input.value).toBe('Toronto Pearson');
    await tick(PICK_TIMING.capMs);
    expect(await done).toBe('done');
    expect(input.value).toBe('Toronto Pearson International (YYZ)');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('falls back from exact to prefix to contains, and tries the part before a comma', () => {
    const list = document.createElement('div');
    list.setAttribute('role', 'listbox');
    list.innerHTML = ['Montréal-Trudeau (YUL)', 'Montreal, QC, Canada', 'Greater Montreal area'].map((o) => `<div role="option">${o}</div>`).join('');
    document.body.append(list);
    expect(matchOption(list, 'Montreal, QC, Canada')?.textContent).toBe('Montreal, QC, Canada');
    expect(matchOption(list, 'montreal')?.textContent).toBe('Montreal, QC, Canada');
    expect(matchOption(list, 'Greater')?.textContent).toBe('Greater Montreal area');
    expect(matchOption(list, 'Montreal, Quebec')?.textContent).toBe('Montreal, QC, Canada');
    expect(matchOption(list, 'Ottawa')).toBeNull();
  });

  it('leaves the typed text and reports partial when no list appears within the cap', async () => {
    const input = combobox();
    const done = performFill(input, 'Toronto', 'www.google.com');
    await tick(PICK_TIMING.capMs + PICK_TIMING.pollMs);
    expect(await done).toBe('partial');
    expect(input.value).toBe('Toronto');
  });

  it('reports partial when the list opens but nothing in it matches, touching no option', async () => {
    const input = combobox();
    pageOpensList(input, ['Ottawa (YOW)', 'Halifax (YHZ)']);
    const clicks = vi.fn();
    document.body.addEventListener('click', clicks);
    const done = performFill(input, 'Toronto', 'www.google.com');
    await tick(PICK_TIMING.capMs * 2 + PICK_TIMING.pollMs);
    expect(await done).toBe('partial');
    expect(input.value).toBe('Toronto');
    expect(clicks).not.toHaveBeenCalled();
  });

  it('presses ArrowDown and Enter when the list ignores the click and stays open', async () => {
    const input = combobox();
    const list = document.getElementById('from-list')!;
    list.hidden = false;
    list.innerHTML = '<div role="option">Toronto Pearson (YYZ)</div>';
    const keys: string[] = [];
    input.addEventListener('keydown', (e) => {
      keys.push(e.key);
      if (e.key === 'Enter') {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Toronto Pearson (YYZ)');
        list.hidden = true;
      }
    });
    // The text is already typed; the click on the option does nothing to this page.
    input.value = 'Toronto';
    const done = pickFromListbox(input, 'Toronto');
    await tick(0);
    expect(await done).toBe('done');
    expect(keys).toEqual(['ArrowDown', 'Enter']);
    expect(input.value).toBe('Toronto Pearson (YYZ)');
  });

  it('picks from the first visible listbox when the control names none', async () => {
    document.body.innerHTML = `
      <input id="city" role="combobox" aria-expanded="false">
      <ul role="listbox" hidden><li role="option">Vancouver</li></ul>
    `;
    const input = document.getElementById('city') as HTMLInputElement;
    const list = document.querySelector('[role=listbox]') as HTMLElement;
    const picked = vi.fn();
    list.firstElementChild!.addEventListener('mousedown', picked);
    input.addEventListener('input', () => setTimeout(() => (list.hidden = false), 50));
    const done = performFill(input, 'vancouver', 'example.com');
    await tick(PICK_TIMING.capMs);
    expect(await done).toBe('done');
    expect(picked).toHaveBeenCalledTimes(1);
  });
});

describe('date fields', () => {
  it('parses ISO, ISO with a time, spelled dates, and a month and day with no year as the next such date', () => {
    const now = new Date(2026, 9, 10); // 10 Oct 2026
    expect(parseDate('2026-09-26')).toEqual({ y: 2026, m: 9, d: 26 });
    expect(parseDate('2026-09-26T18:00:00-04:00')).toEqual({ y: 2026, m: 9, d: 26 });
    expect(parseDate('Sep 26, 2026')).toEqual({ y: 2026, m: 9, d: 26 });
    expect(parseDate('26 September 2026')).toEqual({ y: 2026, m: 9, d: 26 });
    expect(parseDate('Sep 26', now)).toEqual({ y: 2027, m: 9, d: 26 });
    expect(parseDate('Oct 20', now)).toEqual({ y: 2026, m: 10, d: 20 });
    expect(parseDate('Seven Shores Cafe')).toBeNull();
    expect(parseDate('2026-13-40')).toBeNull();
  });

  it('knows a date field by type, by a placeholder that spells the format, or by a label like Departure', () => {
    const date = document.createElement('input');
    date.type = 'date';
    expect(isDateField(date)).toBe(true);
    const spelled = document.createElement('input');
    spelled.placeholder = 'dd/mm/yyyy';
    expect(isDateField(spelled)).toBe(true);
    const depart = document.createElement('input');
    depart.setAttribute('aria-label', 'Departure');
    expect(isDateField(depart)).toBe(true);
    const search = document.createElement('input');
    search.setAttribute('aria-label', 'Where to?');
    expect(isDateField(search)).toBe(false);
  });

  it('formats for the field: ISO for type=date, the placeholder pattern, else the locale', () => {
    const p = { y: 2026, m: 9, d: 6 };
    const date = document.createElement('input');
    date.type = 'date';
    expect(formatDate(p, date)).toBe('2026-09-06');
    const uk = document.createElement('input');
    uk.placeholder = 'DD/MM/YYYY';
    expect(formatDate(p, uk)).toBe('06/09/2026');
    const us = document.createElement('input');
    us.placeholder = 'mm-dd-yy';
    expect(formatDate(p, us)).toBe('09-06-26');
    const plain = document.createElement('input');
    expect(formatDate(p, plain, 'en-US')).toBe('09/06/2026');
    expect(formatDate(p, plain, 'en-CA')).toBe('2026-09-06');
  });

  it('sets a type=date input through the setter with an ISO value, and is done when no calendar opens', async () => {
    document.body.innerHTML = '<label for="d">Departure date</label><input id="d" type="date">';
    const input = document.getElementById('d') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    const done = performFill(input, 'Sep 26, 2026', 'example.com');
    await tick(DATE_TIMING.gridCapMs + 50);
    expect(await done).toBe('done');
    expect(input.value).toBe('2026-09-26');
    expect(events).toEqual(['input', 'change']);
  });

  function calendar(input: HTMLInputElement, firstMonth: { y: number; m: number }): { shown: () => string } {
    let month = firstMonth;
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.hidden = true;
    dialog.innerHTML = `
      <button aria-label="Previous month">‹</button>
      <button aria-label="Next month">›</button>
      <div role="grid"></div>
    `;
    document.body.append(dialog);
    const grid = dialog.querySelector('[role=grid]') as HTMLElement;
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const render = (): void => {
      grid.innerHTML = Array.from({ length: 28 }, (_, i) => {
        const d = i + 1;
        const iso = `${month.y}-${String(month.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        return `<div role="gridcell" data-iso="${iso}" aria-label="${names[month.m - 1]} ${d}, ${month.y}"><div role="button">${d}</div></div>`;
      }).join('');
    };
    render();
    dialog.querySelector('[aria-label="Next month"]')!.addEventListener('click', () => {
      month = month.m === 12 ? { y: month.y + 1, m: 1 } : { y: month.y, m: month.m + 1 };
      render();
    });
    dialog.querySelector('[aria-label="Previous month"]')!.addEventListener('click', () => {
      month = month.m === 1 ? { y: month.y - 1, m: 12 } : { y: month.y, m: month.m - 1 };
      render();
    });
    input.addEventListener('focus', () => setTimeout(() => (dialog.hidden = false), 30));
    grid.addEventListener('click', (e) => {
      const cell = (e.target as Element).closest('[role=gridcell]');
      if (!cell) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, cell.getAttribute('data-iso')!);
      dialog.hidden = true;
    });
    return { shown: () => `${month.y}-${month.m}` };
  }

  it('types the date, then turns the calendar that opened to the month and presses the day', async () => {
    document.body.innerHTML = '<input id="dep" aria-label="Departure" placeholder="Departure">';
    const input = document.getElementById('dep') as HTMLInputElement;
    const cal = calendar(input, { y: 2026, m: 7 });
    const done = performFill(input, '2026-09-26', 'www.google.com', { locale: 'en-US' });
    await tick(0);
    expect(input.value).toBe('09/26/2026');
    await tick(DATE_TIMING.gridCapMs + DATE_TIMING.stepMs * 3);
    expect(await done).toBe('done');
    expect(cal.shown()).toBe('2026-9');
    expect(input.value).toBe('2026-09-26');
  });

  it('turns backwards when the target is earlier, and stops as partial after the step cap', async () => {
    document.body.innerHTML = '<input id="dep" aria-label="Return date">';
    const input = document.getElementById('dep') as HTMLInputElement;
    const cal = calendar(input, { y: 2026, m: 11 });
    const back = performFill(input, '2026-09-05', 'example.com');
    await tick(DATE_TIMING.gridCapMs + DATE_TIMING.stepMs * 3);
    expect(await back).toBe('done');
    expect(cal.shown()).toBe('2026-9');

    document.body.innerHTML = '<input id="far" aria-label="Departure">';
    const far = document.getElementById('far') as HTMLInputElement;
    calendar(far, { y: 2026, m: 1 });
    const gaveUp = performFill(far, '2028-06-01', 'example.com');
    await tick(DATE_TIMING.gridCapMs + DATE_TIMING.stepMs * (DATE_TIMING.maxMonthSteps + 2));
    expect(await gaveUp).toBe('partial');
  });

  it('finds a cell by aria-label in either word order, or by an ISO data attribute, skipping disabled ones', () => {
    const grid = document.createElement('div');
    grid.setAttribute('role', 'grid');
    grid.innerHTML = `
      <td aria-label="26 September 2026" aria-disabled="true">26</td>
      <div role="gridcell" aria-label="Saturday, September 26, 2026">26</div>
      <div role="gridcell" data-date="2026-09-27">27</div>
    `;
    document.body.append(grid);
    expect(findCell(grid, { y: 2026, m: 9, d: 26 })?.getAttribute('role')).toBe('gridcell');
    expect(findCell(grid, { y: 2026, m: 9, d: 27 })?.getAttribute('data-date')).toBe('2026-09-27');
    expect(findCell(grid, { y: 2026, m: 9, d: 28 })).toBeNull();
    expect(pickFromCalendar).toBeTypeOf('function');
  });

  it('falls through to a plain text fill when the value is not a date', async () => {
    document.body.innerHTML = '<input id="dep" aria-label="Departure">';
    const input = document.getElementById('dep') as HTMLInputElement;
    expect(await performFill(input, 'whenever', 'example.com')).toBe('done');
    expect(input.value).toBe('whenever');
  });
});

describe('option cards', () => {
  it('performs a click on a card through its own Select button, radio, or the card itself, and refuses a chosen card', () => {
    document.body.innerHTML = `
      <li id="a"><span>Air Canada $312 round trip</span><button>Select flight</button></li>
      <li id="b"><label><input type="radio" name="fare"> Basic fare, no bags</label></li>
      <div id="c" role="option" aria-selected="false">Flex fare</div>
      <div id="d" role="option" aria-selected="true">Chosen already</div>
    `;
    const hits: string[] = [];
    document.querySelector('#a button')!.addEventListener('click', () => hits.push('a-button'));
    document.querySelector('#b input')!.addEventListener('click', () => hits.push('b-radio'));
    const c = document.getElementById('c')!;
    c.addEventListener('mousedown', () => hits.push('c-mousedown'));
    c.addEventListener('click', () => hits.push('c-click'));
    expect(performInteraction(document.getElementById('a')!, 'click', 'x', 'option')).toBe(true);
    expect(performInteraction(document.getElementById('b')!, 'click', 'x', 'option')).toBe(true);
    expect(performInteraction(c, 'click', 'x', 'option')).toBe(true);
    expect(hits).toEqual(['a-button', 'b-radio', 'c-mousedown', 'c-click']);
    expect(stillFits(document.getElementById('d')!, 'click', 'option')).toBe(false);
    expect(stillFits(c, 'click', 'option')).toBe(true);
  });
});

describe('elements from another document', () => {
  it('fills and clicks inside a same-origin child frame, whose elements are not this document\'s classes', async () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<input aria-label="Card number"><select aria-label="Country"><option>Canada</option><option>France</option></select><button>Continue</button>';
    const input = doc.querySelector('input')!;
    const select = doc.querySelector('select')!;
    const button = doc.querySelector('button')!;
    // The whole point: the top document's classes do not answer for a child frame's elements.
    expect(input instanceof HTMLInputElement).toBe(false);

    expect(await performFill(input, '4242 4242 4242 4242', 'shop.example')).toBe('done');
    expect(input.value).toBe('4242 4242 4242 4242');
    expect(performInteraction(select, 'choose', 'France')).toBe(true);
    expect(select.value).toBe('France');
    const clicks = vi.fn();
    button.addEventListener('click', clicks);
    expect(performInteraction(button, 'click', 'Continue')).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });
});
