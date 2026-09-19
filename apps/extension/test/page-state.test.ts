import { beforeEach, describe, expect, it } from 'vitest';
import type { PageLocation } from '../src/snapshot';
import { pageKind, pageStateOf } from '../src/snapshot';
import { documentHeight, hasMoreBelow, viewportsOf } from '../src/scroll';

/** jsdom lays nothing out, so every element a test cares about gets a box by hand. */
function lay(el: Element, top = 100, width = 300, height = 30): void {
  el.getBoundingClientRect = () => ({ top, left: 0, bottom: top + height, right: width, width, height }) as DOMRect;
}

/** jsdom's location cannot be moved off localhost, so the detector is handed one. */
let here: PageLocation = { host: 'example.com', pathname: '/', search: '' };
function at(path: string): void {
  const [pathname, search] = path.split('?');
  here = { ...here, pathname: pathname ?? '/', search: search ? `?${search}` : '' };
}
function onHost(host: string): void {
  here = { ...here, host };
}
const kind = () => pageKind(document, here);
const state = (done?: string[]) => pageStateOf(document, window, done, here);

function page(height: number, scrollY = 0, innerHeight = 800): void {
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: height });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: scrollY });
}

beforeEach(() => {
  document.body.innerHTML = '';
  here = { host: 'example.com', pathname: '/', search: '' };
  page(800);
});

describe('pageKind', () => {
  it('reads a results page off the URL of a search engine, and off path plus links anywhere else', () => {
    at('/search?q=doordash');
    onHost('www.google.com');
    document.body.innerHTML = '<a href="https://www.doordash.com/">DoorDash</a>';
    expect(kind()).toBe('serp');

    // A search engine with no query is not showing results yet.
    at('/');
    onHost('duckduckgo.com');
    expect(kind()).toBe('unknown');
    at('/?q=pho+near+me');
    onHost('duckduckgo.com');
    expect(kind()).toBe('serp');

    // Any other site needs the path to say search and a list of links to show for it.
    at('/s?k=usb+c+cable');
    onHost('www.amazon.ca');
    expect(kind()).toBe('unknown');
    document.body.innerHTML = Array.from({ length: 6 }, (_, i) => `<a href="/dp/${i}">Cable ${i}</a>`).join('');
    expect(kind()).toBe('serp');
  });

  it('reads a checkout off the path, before anything the DOM says', () => {
    at('/checkout/shipping');
    onHost('shop.example.com');
    document.body.innerHTML = '<article>' + 'text '.repeat(500) + '</article>';
    expect(kind()).toBe('checkout');
    at('/cart');
    expect(kind()).toBe('checkout');
  });

  it('knows the search apps by host and path', () => {
    at('/maps/place/Seven+Shores');
    onHost('www.google.com');
    expect(kind()).toBe('search-app');
    at('/calendar/u/0/r/eventedit');
    onHost('calendar.google.com');
    expect(kind()).toBe('search-app');
  });

  it('calls a form a form by its density, and a long read an article by its landmark', () => {
    onHost('forms.example.com');
    document.body.innerHTML = '<form><input name="a"><input name="b"><textarea name="c"></textarea></form>';
    expect(kind()).toBe('form');

    // Two controls is not what the page is for.
    document.body.innerHTML = '<form><input name="a"><input name="b"></form>';
    expect(kind()).toBe('unknown');

    document.body.innerHTML = `<article>${'walking through the city '.repeat(60)}</article>`;
    expect(kind()).toBe('article');
    // Short text under a landmark is not an article.
    document.body.innerHTML = '<main>Two lines of text.</main>';
    expect(kind()).toBe('unknown');
    // No landmark, but a lot of text, still is.
    document.body.innerHTML = `<div>${'walking through the city '.repeat(130)}</div>`;
    expect(kind()).toBe('article');
  });

  it('calls a stack of articles a feed, and a login page nothing at all', () => {
    onHost('feed.example.com');
    document.body.innerHTML = '<div role="feed"><p>post</p></div>';
    expect(kind()).toBe('feed');
    document.body.innerHTML = Array.from({ length: 5 }, () => '<article>a post</article>').join('');
    expect(kind()).toBe('feed');

    // A visible password field means a login form, which carries no prior of its own.
    at('/checkout/login');
    document.body.innerHTML = '<form><input name="email"><input type="password" name="pw"><input name="x"></form>';
    expect(kind()).toBe('unknown');
  });
});

describe('pageStateOf', () => {
  it('measures the scroll in viewports and says when there is more below', () => {
    onHost('www.theatlantic.com');
    document.body.innerHTML = `<article>${'walking '.repeat(400)}</article>`;
    page(8000, 1200);
    expect(state()).toEqual({ kind: 'article', y: 1.5, pages: 10, more: true });

    page(8000, 7200);
    expect(state()!.more).toBe(false);
    expect(documentHeight(window, document)).toBe(8000);
    expect(viewportsOf(window, document)).toEqual({ y: 9, pages: 10 });
    expect(hasMoreBelow(window, document)).toBe(false);
  });

  it('carries the page query and what carat already did here', () => {
    at('/search?q=doordash');
    onHost('www.google.com');
    document.body.innerHTML = '<a href="https://www.doordash.com/">DoorDash</a>';
    expect(state(['scroll', 'link|doordash'])).toMatchObject({
      kind: 'serp',
      q: 'doordash',
      done: ['scroll', 'link|doordash'],
    });

    // No query in the URL: the search box's own value is the query.
    at('/results');
    onHost('app.example.com');
    document.body.innerHTML = '<input type="search" value="pesto">';
    expect(state()!.q).toBe('pesto');
    // Nothing typed, nothing to carry.
    document.body.innerHTML = '<input type="search">';
    expect(state()!.q).toBeUndefined();
  });

  it('says nothing in a sub-frame', () => {
    const frame = { self: {}, top: {}, innerHeight: 800, scrollY: 0 } as unknown as Window;
    expect(pageStateOf(document, frame)).toBeUndefined();
  });
});
