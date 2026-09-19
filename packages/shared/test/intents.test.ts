import { describe, expect, it } from 'vitest';
import { INTENTS, INTENT_REGISTRY, buildIntentUrl, calendarDates, intentLabel, isIntentDestination, resolveIntentValue } from '../src/intents';

const entity = (over: Partial<{ value: string; when: string; location: string }> = {}) => ({
  value: '',
  when: '',
  location: '',
  ...over,
});

describe('buildIntentUrl', () => {
  it('builds a Maps search from a place name', () => {
    expect(buildIntentUrl('maps', entity({ value: 'Seven Shores Cafe' }))).toBe(
      'https://www.google.com/maps/search/?api=1&query=Seven+Shores+Cafe',
    );
    expect(buildIntentUrl('maps', entity({ value: '  ' }))).toBeNull();
  });

  it('builds a Calendar event with title, wall-clock dates and location', () => {
    const url = buildIntentUrl(
      'calendar',
      entity({ value: 'Dinner at Seven Shores Cafe', when: '2026-09-18T18:00:00-04:00', location: 'Seven Shores Cafe' }),
    );
    const u = new URL(url!);
    expect(u.origin + u.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(u.searchParams.get('action')).toBe('TEMPLATE');
    expect(u.searchParams.get('text')).toBe('Dinner at Seven Shores Cafe');
    expect(u.searchParams.get('dates')).toBe('20260918T180000/20260918T190000');
    expect(u.searchParams.get('location')).toBe('Seven Shores Cafe');
  });

  it('leaves dates out of a Calendar event when the time is missing or malformed', () => {
    for (const when of ['', 'Friday at 6']) {
      const u = new URL(buildIntentUrl('calendar', entity({ value: 'Dinner', when }))!);
      expect(u.searchParams.has('dates')).toBe(false);
      expect(u.searchParams.has('location')).toBe(false);
    }
  });

  it('builds a Gmail compose only for something shaped like an email', () => {
    expect(buildIntentUrl('gmail', entity({ value: 'maya.chen@northbrookstudio.com' }))).toBe(
      'https://mail.google.com/mail/?view=cm&fs=1&to=maya.chen%40northbrookstudio.com',
    );
    expect(buildIntentUrl('gmail', entity({ value: 'Maya Chen' }))).toBeNull();
  });

  it('never lets the entity choose the host', () => {
    for (const intent of INTENTS) {
      const url = buildIntentUrl(intent, entity({ value: 'x@evil.test', when: 'https://evil.test', location: 'https://evil.test' }));
      if (url) expect(isIntentDestination(intent, url)).toBe(true);
    }
  });
});

describe('calendarDates', () => {
  it('keeps the wall clock of the offset the text was resolved in', () => {
    expect(calendarDates('2026-09-18T18:00:00-04:00')).toBe('20260918T180000/20260918T190000');
    expect(calendarDates('2026-09-18T23:30:00+09:00')).toBe('20260918T233000/20260919T003000');
  });

  it('makes a date without a time an all-day event', () => {
    expect(calendarDates('2026-09-18')).toBe('20260918/20260919');
    expect(calendarDates('2026-12-31')).toBe('20261231/20270101');
  });

  it('rejects anything that is not an ISO date', () => {
    expect(calendarDates('')).toBeNull();
    expect(calendarDates('Friday at 6')).toBeNull();
    expect(calendarDates('18/09/2026')).toBeNull();
  });
});

describe('isIntentDestination', () => {
  it('recognises each destination and nothing else', () => {
    expect(isIntentDestination('maps', 'https://www.google.com/maps/place/Seven+Shores+Cafe')).toBe(true);
    expect(isIntentDestination('maps', 'https://maps.google.com/')).toBe(true);
    expect(isIntentDestination('maps', 'https://www.google.com/search?q=maps')).toBe(false);
    expect(isIntentDestination('calendar', 'https://calendar.google.com/calendar/u/0/r')).toBe(true);
    expect(isIntentDestination('gmail', 'https://mail.google.com/mail/u/0/#inbox')).toBe(true);
    expect(isIntentDestination('gmail', 'https://discord.com/channels/1')).toBe(false);
    expect(isIntentDestination('gmail', 'not a url')).toBe(false);
  });
});

describe('intentLabel', () => {
  it('has an open and a focus label for every intent', () => {
    for (const intent of INTENTS) {
      expect(intentLabel(intent, 'open')).toBe(INTENT_REGISTRY[intent].openLabel);
      expect(intentLabel(intent, 'focus')).toContain('Switch to');
    }
    expect(intentLabel('maps', 'open')).toBe('Open in Google Maps');
  });
});

describe('resolveIntentValue', () => {
  it('turns the name the model wrote into a URL from the registry', () => {
    const resolved = resolveIntentValue('maps:Seven Shores Cafe');
    expect(resolved?.intent).toBe('maps');
    expect(resolved?.url).toBe('https://www.google.com/maps/search/?api=1&query=Seven+Shores+Cafe');
  });

  it('takes a time and a place after the title for a calendar event', () => {
    const resolved = resolveIntentValue('calendar:Dinner at Seven Shores Cafe|2026-09-18T18:00|Seven Shores Cafe');
    expect(resolved?.entity).toEqual({
      value: 'Dinner at Seven Shores Cafe',
      when: '2026-09-18T18:00',
      location: 'Seven Shores Cafe',
    });
    expect(new URL(resolved!.url).searchParams.get('dates')).toBe('20260918T180000/20260918T190000');
  });

  it('refuses a URL the model wrote itself, an unknown destination and an entity it cannot use', () => {
    expect(resolveIntentValue('https://evil.test/')).toBeNull();
    expect(resolveIntentValue('slack:#general')).toBeNull();
    expect(resolveIntentValue('maps:')).toBeNull();
    expect(resolveIntentValue('gmail:not an address')).toBeNull();
  });
});
