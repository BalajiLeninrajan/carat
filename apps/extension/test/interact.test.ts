import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementDescriptor } from '@carat/shared';
import { ELEMENT_WINDOW_ABOVE, ELEMENT_WINDOW_BELOW, MAX_ELEMENTS, MAX_ELEMENTS_BYTES, MAX_LINKS, accessibleName, enumerateElements, performInteraction, roleOf, snap, stillFits } from '../src/interact';

function lay(el: Element, width = 120, top = 100, height = 32, left = 0): void {
  el.getBoundingClientRect = () => new DOMRect(left, top, width, height);
}

function layAll(width = 120, top = 100): void {
  for (const el of document.querySelectorAll('button,input,select,a,summary,[role]')) lay(el, width, top);
}

const named = (descriptors: ElementDescriptor[]) => descriptors.map((d) => d.nm);

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enumerateElements', () => {
  it('describes buttons, toggles, sliders, selects, tabs, menu items and disclosures with role, name and state', () => {
    document.body.innerHTML = `
      <h2>Event details</h2>
      <form>
        <button type="submit">Save</button>
        <button type="button" aria-label="Add notification"><svg></svg></button>
        <label><input type="checkbox" id="allday"> All day</label>
        <div role="switch" aria-checked="true" aria-label="Dark mode"></div>
        <label><input type="radio" name="meal" value="veg"> Vegetarian</label>
        <label><input type="radio" name="meal" value="std" checked> Standard</label>
        <label for="vol">Volume</label><input type="range" id="vol" min="0" max="100" step="5" value="80">
        <div role="slider" aria-label="Brightness" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0.5" tabindex="0"></div>
        <label for="show">Show as</label><select id="show"><option>Busy</option><option selected>Free</option></select>
        <div role="tablist"><div role="tab" aria-selected="true">Details</div><div role="tab">Guests</div></div>
        <div role="menu"><div role="menuitem">Duplicate</div></div>
        <button type="button" aria-expanded="false">Advanced</button>
        <details><summary>Notes</summary><p>hidden</p></details>
        <a role="button">Link button</a>
        <a href="https://example.com/">Real link</a>
        <button type="button" aria-pressed="false">Bold</button>
      </form>
    `;
    layAll();
    const { descriptors, registry } = enumerateElements(document);
    const by = (nm: string) => descriptors.find((d) => d.nm === nm)!;

    expect(descriptors.length).toBe(15);
    expect(named(descriptors)).not.toContain('Real link');
    expect(named(descriptors)).not.toContain('Standard'); // a checked radio cannot be chosen again
    expect(by('Save')).toMatchObject({ r: 'button', p: 1 });
    expect(by('Save').nb).toBe('Event details');
    expect(by('Add notification').r).toBe('button');
    expect(by('Link button').r).toBe('button');
    expect(by('All day')).toMatchObject({ r: 'checkbox', st: 'off' });
    expect(by('Dark mode')).toMatchObject({ r: 'switch', st: 'on' });
    expect(by('Vegetarian')).toMatchObject({ r: 'radio', st: 'off' });
    expect(by('Volume')).toMatchObject({ r: 'slider', v: '80', min: 0, max: 100, step: 5 });
    expect(by('Brightness')).toMatchObject({ r: 'slider', v: '0.5', min: 0, max: 1 });
    expect(by('Show as')).toMatchObject({ r: 'select', v: 'Free', op: ['Busy', 'Free'] });
    expect(by('Details')).toMatchObject({ r: 'tab', st: 'selected' });
    expect(by('Guests').st).toBeUndefined();
    expect(by('Duplicate').r).toBe('menuitem');
    expect(by('Advanced')).toMatchObject({ r: 'disclosure', st: 'closed' });
    expect(by('Bold')).toMatchObject({ r: 'switch', st: 'off' });

    for (const d of descriptors) {
      const entry = registry.get(d.i)!;
      expect(entry.el.getAttribute('data-carat-el')).toBe(d.i);
      expect(entry.key).toBe(`${d.r}|${d.nm.toLowerCase()}`);
    }
  });

  it('never lists a destructive name, a hidden or disabled control, a nameless one, or a sub-frame', () => {
    document.body.innerHTML = `
      <button>Delete</button>
      <button aria-label="Send">✈</button>
      <button>Yes, delete it</button>
      <input type="submit" value="Place order">
      <button disabled>Save</button>
      <button aria-disabled="true">Create</button>
      <fieldset disabled><button>Apply</button></fieldset>
      <div aria-hidden="true"><button>Done</button></div>
      <button hidden>Next</button>
      <button></button>
      <button>Keep</button>
      <div inert><button>Behind</button></div>
    `;
    layAll();
    expect(named(enumerateElements(document).descriptors)).toEqual(['Keep']);
    expect(document.querySelectorAll('[data-carat-el]')).toHaveLength(1);

    const frame = { self: {}, top: window, innerHeight: 800, innerWidth: 1000 } as unknown as Window;
    expect(enumerateElements(document, frame).descriptors).toEqual([]);
  });

  it('ranks the primary action first, then the viewport, then controls before buttons, then size', () => {
    document.body.innerHTML = `
      <button id="small">Small</button>
      <button id="big">Big</button>
      <input type="checkbox" id="box"><label for="box">Vegetarian</label>
      <button id="below">Below the fold</button>
      <form><button id="primary">Save</button></form>
      <button id="above">Above</button>
    `;
    const vh = window.innerHeight;
    lay(document.getElementById('small')!, 40);
    lay(document.getElementById('big')!, 300);
    lay(document.getElementById('box')!, 16);
    lay(document.getElementById('below')!, 400, vh + 10);
    lay(document.getElementById('primary')!, 60);
    lay(document.getElementById('above')!, 400, -200);
    const { descriptors } = enumerateElements(document);
    expect(named(descriptors)).toEqual(['Save', 'Vegetarian', 'Big', 'Small', 'Below the fold', 'Above']);
    expect(descriptors.map((d) => d.i)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);
    // Only the two outside the viewport carry the off-screen flag.
    expect(descriptors.map((d) => d.o)).toEqual([undefined, undefined, undefined, undefined, 1, 1]);
  });

  it('keeps an off-screen primary action first and drops off-screen elements before on-screen ones', () => {
    const vh = window.innerHeight;
    document.body.innerHTML =
      '<form><button id="primary">Save</button></form>' +
      Array.from({ length: 30 }, (_, i) => `<button id="${i % 2 ? 'on' : 'off'}${i}">Button number ${i} ${'x'.repeat(50)}</button>`).join('');
    lay(document.getElementById('primary')!, 120, 3 * vh);
    for (const el of document.querySelectorAll('button:not(#primary)')) lay(el, 120, el.id.startsWith('off') ? 2 * vh : 100);
    const { descriptors } = enumerateElements(document);
    expect(descriptors[0]).toMatchObject({ nm: 'Save', p: 1, o: 1 });
    expect(descriptors.length).toBeLessThan(MAX_ELEMENTS);
    expect(descriptors.slice(1).every((d) => d.o === undefined)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(descriptors)).byteLength).toBeLessThanOrEqual(MAX_ELEMENTS_BYTES);
  });

  it('caps the count and the bytes, trimming the registry to match', () => {
    document.body.innerHTML = Array.from({ length: 30 }, (_, i) => `<button>Button number ${i} ${'x'.repeat(50)}</button>`).join('');
    layAll();
    const { descriptors, registry } = enumerateElements(document);
    expect(descriptors.length).toBeLessThanOrEqual(MAX_ELEMENTS);
    expect(descriptors.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(descriptors)).byteLength).toBeLessThanOrEqual(MAX_ELEMENTS_BYTES);
    expect(registry.size).toBe(descriptors.length);
    expect(document.querySelectorAll('[data-carat-el]')).toHaveLength(descriptors.length);
  });

  it('skips elements far outside the vertical window and clears stale ids', () => {
    document.body.innerHTML = '<button id="a">Alpha</button><button id="b">Beta</button><button id="c">Gamma</button><button id="d">Delta</button>';
    const vh = window.innerHeight;
    lay(document.getElementById('a')!, 100, 100);
    lay(document.getElementById('b')!, 100, ELEMENT_WINDOW_BELOW * vh + 1);
    lay(document.getElementById('c')!, 100, ELEMENT_WINDOW_BELOW * vh);
    lay(document.getElementById('d')!, 100, -ELEMENT_WINDOW_ABOVE * vh - 1);
    expect(named(enumerateElements(document).descriptors)).toEqual(['Alpha', 'Gamma']);
    document.getElementById('c')!.remove();
    document.getElementById('a')!.remove();
    expect(enumerateElements(document).descriptors).toEqual([]);
    expect(document.querySelectorAll('[data-carat-el]')).toHaveLength(0);
  });
});

describe('roleOf and accessibleName', () => {
  it('derives roles from tag, type and ARIA', () => {
    const el = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild!;
    };
    expect(roleOf(el('<button></button>'))).toBe('button');
    expect(roleOf(el('<div role="button"></div>'))).toBe('button');
    expect(roleOf(el('<button aria-expanded="true"></button>'))).toBe('disclosure');
    expect(roleOf(el('<button aria-pressed="true"></button>'))).toBe('switch');
    expect(roleOf(el('<input type="checkbox">'))).toBe('checkbox');
    expect(roleOf(el('<input type="range">'))).toBe('slider');
    expect(roleOf(el('<select></select>'))).toBe('select');
    expect(roleOf(el('<a href="#"></a>'))).toBe('link');
    expect(roleOf(el('<summary></summary>'))).toBe('disclosure');
    expect(roleOf(el('<input type="text">'))).toBeNull();
    expect(roleOf(el('<div role="listbox"></div>'))).toBeNull();
  });

  it('names elements from aria-labelledby, aria-label, labels, values, text, title and alt in that order', () => {
    document.body.innerHTML = `
      <span id="l1">Save</span><span id="l2">event</span>
      <button id="a" aria-labelledby="l1 l2" aria-label="nope">text</button>
      <button id="b" aria-label="Add notification">+</button>
      <label for="c">Volume</label><input id="c" type="range">
      <input id="d" type="submit" value="Create">
      <button id="e">  Done <b>now</b> </button>
      <button id="f" title="Close"></button>
      <button id="g"><img alt="Settings"></button>
      <input id="h" type="checkbox">
    `;
    const name = (id: string) => accessibleName(document.getElementById(id)!, document);
    expect(name('a')).toBe('Save event');
    expect(name('b')).toBe('Add notification');
    expect(name('c')).toBe('Volume');
    expect(name('d')).toBe('Create');
    expect(name('e')).toBe('Done now');
    expect(name('f')).toBe('Close');
    expect(name('g')).toBe('Settings');
    expect(name('h')).toBe('');
  });
});

describe('performInteraction', () => {
  it('clicks a button exactly once and focuses it', () => {
    document.body.innerHTML = '<button>Save</button>';
    const btn = document.querySelector('button')!;
    const onClick = vi.fn();
    btn.addEventListener('click', onClick);
    expect(performInteraction(btn, 'click', 'Save')).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(btn);
  });

  it('sets a range input through the native setter and fires input then change', () => {
    document.body.innerHTML = '<input type="range" min="0" max="100" step="5" value="80">';
    const range = document.querySelector('input')!;
    const tracker = vi.fn();
    Object.defineProperty(range, 'value', { configurable: true, get: () => '80', set: tracker });
    const events: string[] = [];
    range.addEventListener('input', () => events.push('input'));
    range.addEventListener('change', () => events.push('change'));

    expect(performInteraction(range, 'set', '42')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!.call(range)).toBe('40');
    expect(tracker).not.toHaveBeenCalled();
    expect(events).toEqual(['input', 'change']);
    expect(performInteraction(range, 'set', 'loud')).toBe(false);
  });

  it('moves a role=slider by arrow keys to the nearest step, Home and End for the ends', () => {
    document.body.innerHTML = '<div role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80" step="5"></div>';
    const slider = document.querySelector('div')!;
    const keys: string[] = [];
    // A widget that listens to keys, like most do.
    slider.addEventListener('keydown', (e) => {
      keys.push(e.key);
      const now = Number(slider.getAttribute('aria-valuenow'));
      const next = e.key === 'ArrowRight' ? now + 5 : e.key === 'ArrowLeft' ? now - 5 : e.key === 'Home' ? 0 : e.key === 'End' ? 100 : now;
      slider.setAttribute('aria-valuenow', String(next));
    });

    expect(performInteraction(slider, 'set', '42')).toBe(true);
    expect(keys).toEqual(Array<string>(8).fill('ArrowLeft'));
    expect(slider.getAttribute('aria-valuenow')).toBe('40');

    keys.length = 0;
    expect(performInteraction(slider, 'set', '0')).toBe(true);
    expect(keys).toEqual(['Home']);
    expect(performInteraction(slider, 'set', '100')).toBe(true);
    expect(keys).toEqual(['Home', 'End']);
    expect(performInteraction(slider, 'set', '100')).toBe(true);
    expect(keys).toEqual(['Home', 'End']); // already there: no keys at all
  });

  it('falls back to writing aria-valuenow only when the slider ignored every key', () => {
    document.body.innerHTML = '<div role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="10" aria-valuenow="2"></div>';
    const slider = document.querySelector('div')!;
    const keydown = vi.fn();
    slider.addEventListener('keydown', keydown);
    expect(performInteraction(slider, 'set', '7')).toBe(true);
    expect(keydown).toHaveBeenCalledTimes(5);
    expect(slider.getAttribute('aria-valuenow')).toBe('7');
  });

  it('checks and unchecks only when the state differs, with one click', () => {
    document.body.innerHTML = '<input type="checkbox"><div role="checkbox" aria-checked="true" tabindex="0"></div>';
    const box = document.querySelector('input')!;
    const aria = document.querySelector('div')!;
    const clicks = vi.fn();
    box.addEventListener('click', clicks);
    aria.addEventListener('click', () => {
      clicks();
      aria.setAttribute('aria-checked', aria.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
    });

    expect(performInteraction(box, 'check', 'Vegetarian')).toBe(true);
    expect(box.checked).toBe(true);
    expect(performInteraction(box, 'check', 'Vegetarian')).toBe(true);
    expect(box.checked).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);

    expect(performInteraction(aria, 'check', 'Dark mode')).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(performInteraction(aria, 'uncheck', 'Dark mode')).toBe(true);
    expect(aria.getAttribute('aria-checked')).toBe('false');
    expect(clicks).toHaveBeenCalledTimes(2);

    expect(stillFits(box, 'check')).toBe(false);
    expect(stillFits(box, 'uncheck')).toBe(true);
    expect(performInteraction(document.body, 'check', 'x')).toBe(false);
  });

  it('chooses a select option and refuses the wrong verb for an element', () => {
    document.body.innerHTML = '<select><option>Busy</option><option>Free</option></select><button>Save</button>';
    const select = document.querySelector('select')!;
    const change = vi.fn();
    select.addEventListener('change', change);
    expect(performInteraction(select, 'choose', 'free')).toBe(true);
    expect(select.value).toBe('Free');
    expect(change).toHaveBeenCalledTimes(1);
    expect(performInteraction(select, 'choose', 'Tentative')).toBe(false);
    expect(performInteraction(document.querySelector('button')!, 'set', '3')).toBe(false);
    expect(performInteraction(document.querySelector('button')!, 'choose', 'x')).toBe(false);
  });
});

describe('enumerateLinks', () => {
  const withQuery = (q = 'doordash') => window.history.pushState({}, '', `/search?q=${encodeURIComponent(q)}`);
  const noQuery = () => window.history.pushState({}, '', '/');
  const links = (descriptors: ElementDescriptor[]) => descriptors.filter((d) => d.r === 'link' && d.h);

  afterEach(noQuery);

  it('describes real links with their title and destination site only while the page has a query', () => {
    document.body.innerHTML = `
      <button>Tools</button>
      <a href="https://www.doordash.com/en-CA/">DoorDash Food Delivery</a>
      <a href="/local/page">Same site</a>
      <a href="https://news.bbc.co.uk/story"><h3>A story</h3><p>with a blurb under it</p></a>
      <a href="https://example.org/" aria-label="Example site"><img src="x.png"></a>
    `;
    layAll();
    expect(links(enumerateElements(document).descriptors)).toEqual([]);

    withQuery();
    const { descriptors, registry } = enumerateElements(document);
    expect(links(descriptors)).toEqual([
      { i: 'e0', r: 'link', nm: 'DoorDash Food Delivery', h: 'doordash.com' },
      { i: 'e1', r: 'link', nm: 'Same site', h: 'localhost' },
      { i: 'e2', r: 'link', nm: 'A story', h: 'bbc.co.uk' },
      { i: 'e3', r: 'link', nm: 'Example site', h: 'example.org' },
    ]);
    // Links rank before plain buttons, and the registry carries the site for the chip.
    expect(named(descriptors)).toEqual(['DoorDash Food Delivery', 'Same site', 'A story', 'Example site', 'Tools']);
    expect(registry.get('e0')).toMatchObject({ role: 'link', site: 'doordash.com', key: 'link|doordash food delivery' });
    expect(registry.get('e0')!.el).toBe(document.querySelector('a'));
    expect(registry.get('e0')!.at).toBeUndefined();
  });

  it('reads the query off a filled search field too, but never next to a visible password field', () => {
    document.body.innerHTML = '<input type="search" value="doordash"><a href="https://www.doordash.com/">DoorDash</a>';
    layAll();
    expect(links(enumerateElements(document).descriptors)).toHaveLength(1);
    document.body.insertAdjacentHTML('beforeend', '<input type="password">');
    expect(links(enumerateElements(document).descriptors)).toEqual([]);
  });

  it('never lists mailto, tel or javascript links, downloads, nav, header, footer or cookie-banner links, denylisted hosts, action paths, or short destructive names', () => {
    withQuery();
    document.body.innerHTML = `
      <nav><a href="https://www.doordash.com/nav">In nav</a></nav>
      <header><a href="https://www.doordash.com/header">In header</a></header>
      <div role="navigation"><a href="https://www.doordash.com/tabs">Images</a></div>
      <div id="cookie-banner"><a href="https://www.doordash.com/cookies">Cookie policy</a></div>
      <div class="consent-wall"><a href="https://www.doordash.com/consent">Accept all</a></div>
      <a href="mailto:hi@doordash.com">Email us</a>
      <a href="tel:+15195550142">Call us</a>
      <a href="javascript:void(0)">Do a thing</a>
      <a href="#top">Top of page</a>
      <a href="https://www.doordash.com/menu.pdf" download>Menu</a>
      <a href="https://www.paypal.com/">Pay with PayPal</a>
      <a href="https://app.chase.com/">Chase</a>
      <a href="https://www.doordash.com/logout">Sign out</a>
      <a href="https://www.doordash.com/account/unsubscribe">Manage emails</a>
      <a href="https://www.doordash.com/cart/checkout">Continue</a>
      <a href="https://www.doordash.com/help">Delete account</a>
      <a href="https://www.doordash.com/">Order Now | Quick and Easy Food Delivery</a>
      <a href="https://www.doordash.com/x" aria-disabled="true">Disabled</a>
      <div aria-hidden="true"><a href="https://www.doordash.com/y">Hidden</a></div>
      <a href="https://www.doordash.com/z"></a>
      <footer><a href="https://www.doordash.com/footer">In footer</a></footer>
    `;
    layAll();
    const { descriptors } = enumerateElements(document);
    expect(links(descriptors).map((d) => d.nm)).toEqual(['Order Now | Quick and Easy Food Delivery']);
    // The javascript: anchor is still a button-like element, as before.
    expect(descriptors.find((d) => d.nm === 'Do a thing')).toMatchObject({ r: 'link' });
    expect(descriptors.find((d) => d.nm === 'Do a thing')!.h).toBeUndefined();
  });

  it('caps links at eight in page order, keeps controls ahead of them, and stays inside the element cap and byte budget', () => {
    withQuery();
    document.body.innerHTML =
      Array.from({ length: 12 }, (_, i) => `<a href="https://site${i}.example.com/">Result number ${i} ${'x'.repeat(30)}</a>`).join('') +
      Array.from({ length: 12 }, (_, i) => `<button>Button ${i}</button>`).join('') +
      '<label><input type="checkbox" id="veg"> Vegetarian</label>';
    layAll();
    const { descriptors, registry } = enumerateElements(document);
    const ls = links(descriptors);
    expect(ls).toHaveLength(MAX_LINKS);
    expect(ls.map((d) => d.nm.slice(0, 15))).toEqual(Array.from({ length: 8 }, (_, i) => `Result number ${i}`));
    expect(descriptors.length).toBeLessThanOrEqual(MAX_ELEMENTS);
    expect(descriptors[0]!.nm).toBe('Vegetarian');
    expect(descriptors.findIndex((d) => d.r === 'button')).toBeGreaterThan(descriptors.findIndex((d) => d.r === 'link'));
    expect(new TextEncoder().encode(JSON.stringify(descriptors)).byteLength).toBeLessThanOrEqual(MAX_ELEMENTS_BYTES);
    expect(registry.size).toBe(descriptors.length);
  });

  it('describes links from the viewport down to one screen below, flagging the off-screen ones', () => {
    withQuery();
    const vh = window.innerHeight;
    document.body.innerHTML = '<a id="a" href="https://a.example.com/">Above</a><a id="b" href="https://b.example.com/">In view</a><a id="c" href="https://c.example.com/">One below</a><a id="d" href="https://d.example.com/">Two below</a>';
    lay(document.getElementById('a')!, 100, -200);
    lay(document.getElementById('b')!, 100, 100);
    lay(document.getElementById('c')!, 100, vh + 10);
    lay(document.getElementById('d')!, 100, 2 * vh);
    const { descriptors } = enumerateElements(document);
    expect(descriptors.map((d) => [d.nm, d.o])).toEqual([
      ['In view', undefined],
      ['One below', 1],
    ]);
  });

  it("on a results page, takes each result title's anchor, names it by the title, skips links that stay on the search site, and sits the chip on the title", () => {
    withQuery();
    document.body.innerHTML = `
      <div role="navigation"><a href="/search?q=doordash&tbm=isch">Images</a></div>
      <div data-attrid="kc:/x"><a href="https://www.doordash.com/kp"><h3>Knowledge panel title</h3></a></div>
      <div id="paa"><div role="button"><span>What is DoorDash?</span></div></div>
      <div><a href="/imgres?imgurl=x"><h3>Image pack</h3></a></div>
      <div>
        <a href="https://www.doordash.com/en-CA/"><h3>Order Now | Quick and Easy Food Delivery</h3><div>DoorDash https://www.doordash.com</div></a>
        <div>Get food delivered from your favourite restaurants...</div>
      </div>
      <div><a href="https://en.wikipedia.org/wiki/DoorDash"><h3>DoorDash - Wikipedia</h3></a></div>
      <div id="rhs"><a href="https://www.doordash.com/about"><h3>About DoorDash</h3></a></div>
      <div><h2><a href="https://www.ubereats.com/">Uber Eats</a></h2></div>
      <a href="https://translate.google.com/">Translate</a>
    `;
    for (const el of document.querySelectorAll('a,h2,h3,[role]')) lay(el);
    const { descriptors, registry } = enumerateElements(document, window, { host: 'www.google.com', path: '/search' });
    expect(links(descriptors)).toEqual([
      { i: 'e0', r: 'link', nm: 'Order Now | Quick and Easy Food Delivery', h: 'doordash.com' },
      { i: 'e1', r: 'link', nm: 'DoorDash - Wikipedia', h: 'wikipedia.org' },
      { i: 'e2', r: 'link', nm: 'Uber Eats', h: 'ubereats.com' },
    ]);
    // The "People also ask" question is a button, never a link.
    expect(descriptors.find((d) => d.nm === 'What is DoorDash?')).toMatchObject({ r: 'button' });
    const first = registry.get('e0')!;
    expect(first.el).toBe(document.querySelector('a[href="https://www.doordash.com/en-CA/"]'));
    expect(first.at).toBe(first.el.querySelector('h3'));
    expect(first.site).toBe('doordash.com');
    // An anchor inside its heading (DuckDuckGo, Bing) is clicked itself; the chip sits on the heading.
    expect(registry.get('e2')!.el).toBe(document.querySelector('a[href="https://www.ubereats.com/"]'));
    expect(registry.get('e2')!.at).toBe(document.querySelector('h2'));
  });

  it('never describes a link without a query, whatever the adapter finds', () => {
    document.body.innerHTML = '<a href="https://www.doordash.com/"><h3>Order Now</h3></a>';
    layAll();
    lay(document.querySelector('h3')!);
    expect(enumerateElements(document, window, { host: 'www.google.com', path: '/search' }).descriptors).toEqual([]);
  });
});

describe('snap', () => {
  it('clamps and moves to the nearest step from the minimum', () => {
    expect(snap(42, 0, 100, 5)).toBe(40);
    expect(snap(43, 0, 100, 5)).toBe(45);
    expect(snap(140, 0, 100, 1)).toBe(100);
    expect(snap(-3, -50, 50, 5)).toBe(-5);
    expect(snap(0.66, 0, 1, 0.1)).toBe(0.7);
    expect(snap(7, 0, 10, 0)).toBe(7);
    expect(snap(Number.NaN, 0, 10, 1)).toBeNull();
  });
});
