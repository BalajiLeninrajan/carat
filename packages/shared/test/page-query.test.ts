import { describe, expect, it } from 'vitest';
import type { ElementDescriptor } from '../src/types';
import {
  PAGE_QUERY_CONFIDENCE,
  PAGE_SOURCE,
  domainLabel,
  firstMatchingLink,
  isSiteLink,
  linkMatchesQuery,
  linkRelatesToQuery,
  pageIntent,
  queryTokens,
  registrableDomain,
} from '../src/page-query';
import { EAGERNESS } from '../src/eagerness';

const serp = { host: 'www.google.com', title: 'doordash - Google Search', path: '/search' };
const doordash: ElementDescriptor = { i: 'e1', r: 'link', nm: 'Order Now | Quick and Easy Food Delivery', h: 'doordash.com' };
const ubereats: ElementDescriptor = { i: 'e2', r: 'link', nm: 'Food Delivery Near Me - Order Online', h: 'ubereats.com' };
const yelp: ElementDescriptor = { i: 'e3', r: 'link', nm: 'Best restaurants near you', h: 'yelp.com' };
const intent = (query: string) => pageIntent({ ...serp, query })!;

describe('pageIntent', () => {
  it('reads the query the content script took off the URL', () => {
    expect(pageIntent({ ...serp, query: 'doordash' })).toEqual({ query: 'doordash', tokens: ['doordash'] });
    expect(pageIntent({ ...serp, query: '  Food delivery, near me!  ' })).toEqual({ query: 'Food delivery, near me!', tokens: ['food', 'delivery', 'near', 'me'] });
  });

  it('falls back to a described search field that has a value, and to nothing else', () => {
    const q = { i: 'f0', t: 'textarea', nm: 'q', al: 'Search', v: 'doordash', f: 1 as const };
    expect(pageIntent(serp, [q])).toEqual({ query: 'doordash', tokens: ['doordash'] });
    expect(pageIntent(serp, [{ i: 'f0', t: 'input:search', v: 'DoorDash' }])).toMatchObject({ tokens: ['doordash'] });
    expect(pageIntent(serp, [{ i: 'f0', t: 'input:text', lb: 'Search recipes', v: 'pesto' }])).toMatchObject({ tokens: ['pesto'] });
    expect(pageIntent(serp, [{ i: 'f0', t: 'input:text', lb: 'Add title', v: 'doordash' }])).toBeNull();
    expect(pageIntent(serp, [{ ...q, v: undefined }])).toBeNull();
    expect(pageIntent(serp)).toBeNull();
    expect(pageIntent({ ...serp, query: ' !!! ' })).toBeNull();
  });

  it('prefers the URL over a field and clips a long query', () => {
    expect(pageIntent({ ...serp, query: 'weather' }, [{ i: 'f0', t: 'input:search', v: 'doordash' }])!.query).toBe('weather');
    expect(pageIntent({ ...serp, query: 'x'.repeat(200) })!.query).toHaveLength(80);
  });
});

describe('queryTokens and registrableDomain', () => {
  it('lowercases, strips punctuation and splits on whitespace', () => {
    expect(queryTokens('DoorDash!')).toEqual(['doordash']);
    expect(queryTokens("door-dash's menu")).toEqual(['door', 'dashs', 'menu']);
    expect(queryTokens('   ')).toEqual([]);
    expect(queryTokens('café Zürich')).toEqual(['café', 'zürich']);
  });

  it('keeps two labels, or three under a country second level', () => {
    expect(registrableDomain('www.doordash.com')).toBe('doordash.com');
    expect(registrableDomain('doordash.com')).toBe('doordash.com');
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('abc.com.au.')).toBe('abc.com.au');
    expect(registrableDomain('a.b.c.example.org')).toBe('example.org');
    expect(registrableDomain('localhost')).toBe('localhost');
    expect(domainLabel('doordash.com')).toBe('doordash');
    expect(domainLabel('bbc.co.uk')).toBe('bbc');
  });
});

describe('linkMatchesQuery', () => {
  it('matches the site name or every query word in the title', () => {
    expect(linkMatchesQuery(doordash, intent('doordash'))).toBe(true);
    expect(linkMatchesQuery(doordash, intent('DoorDash'))).toBe(true);
    expect(linkMatchesQuery(doordash, intent('door dash'))).toBe(true);
    expect(linkMatchesQuery(doordash, intent('food delivery'))).toBe(true);
    expect(linkMatchesQuery(ubereats, intent('uber'))).toBe(true);
    expect(linkMatchesQuery(ubereats, intent('uber eats'))).toBe(true);
  });

  it('does not match a partial title, a short fragment of a domain, or an unrelated query', () => {
    expect(linkMatchesQuery(doordash, intent('food delivery near me'))).toBe(false);
    expect(linkMatchesQuery(doordash, intent('weather'))).toBe(false);
    expect(linkMatchesQuery({ nm: 'Meetup', h: 'meetup.com' }, intent('me'))).toBe(false);
    expect(linkMatchesQuery({ nm: 'Order Now', h: 'doordash.com' }, intent('dash'))).toBe(true);
    expect(linkMatchesQuery({ nm: 'Order Now' }, intent('doordash'))).toBe(false);
  });
});

describe('linkRelatesToQuery', () => {
  it('needs one real word in common where an exact match needs them all', () => {
    expect(linkRelatesToQuery(doordash, intent('food delivery near me'))).toBe(true);
    expect(linkRelatesToQuery(ubereats, intent('food delivery near me'))).toBe(true);
    expect(linkRelatesToQuery(yelp, intent('food delivery near me'))).toBe(true); // "near"
    expect(linkRelatesToQuery(yelp, intent('food delivery'))).toBe(false);
    expect(linkRelatesToQuery(doordash, intent('weather'))).toBe(false);
    expect(linkRelatesToQuery(doordash, intent('me'))).toBe(false);
    expect(linkRelatesToQuery(ubereats, intent('eat well'))).toBe(true); // "eat" is in ubereats
  });
});

describe('firstMatchingLink and isSiteLink', () => {
  const elements: ElementDescriptor[] = [
    { i: 'e0', r: 'button', nm: 'Search', p: 1 },
    { i: 'e5', r: 'link', nm: 'doordash', },
    yelp,
    doordash,
    ubereats,
  ];

  it('takes the first real link in page order that the query names, or nothing', () => {
    expect(firstMatchingLink(elements, intent('doordash'))).toBe(doordash);
    expect(firstMatchingLink(elements, intent('food delivery'))).toBe(doordash);
    expect(firstMatchingLink(elements, intent('uber eats'))).toBe(ubereats);
    expect(firstMatchingLink(elements, intent('weather'))).toBeNull();
    expect(firstMatchingLink(elements, null)).toBeNull();
  });

  it('counts only links with a destination site as real links', () => {
    expect(isSiteLink(doordash)).toBe(true);
    expect(isSiteLink({ r: 'link' })).toBe(false);
    expect(isSiteLink({ r: 'link', h: '' })).toBe(false);
    expect(isSiteLink({ r: 'button', h: 'doordash.com' })).toBe(false);
  });

  it('pins the page source and a confidence above every level\'s floor', () => {
    expect(PAGE_SOURCE).toBe('page');
    for (const knobs of Object.values(EAGERNESS)) expect(PAGE_QUERY_CONFIDENCE).toBeGreaterThanOrEqual(knobs.minConfidence);
  });
});
