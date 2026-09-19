import { beforeAll, describe, expect, it } from 'vitest';
import type { SuggestRequest } from '@carat/shared';
import { LocalProvider } from '../src/local';
import { classifyField } from '../src/local/fields';
import { extractAddress, extractEmailRequest, extractPhone, extractPlace, extractWhen } from '../src/local/extract';
import { judge, loadFixtures, type Fixture } from '../eval/fixtures';

const signal = new AbortController().signal;
const local = new LocalProvider();
let fixtures: Map<string, Fixture>;

beforeAll(async () => {
  fixtures = new Map((await loadFixtures()).map((f) => [f.name, f]));
});

function fixture(name: string): Fixture {
  const f = fixtures.get(name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
}

describe('LocalProvider', () => {
  it('fills the Maps search box with the place from the Discord message', async () => {
    const out = await local.suggest(fixture('discord-maps-search').request, { signal });
    expect(out).toEqual([
      expect.objectContaining({ kind: 'fill', fieldId: 'f0', value: 'Seven Shores Cafe', confidence: 0.75, sourceContextId: 'c1' }),
    ]);
  });

  it('fills the Calendar location field with the street address from the Maps panel', async () => {
    const out = await local.suggest(fixture('maps-calendar-location').request, { signal });
    const location = out.find((s) => s.kind === 'fill' && s.fieldId === 'f1');
    expect(location?.value).toBe('10 Regina St N, Waterloo, ON N2J 2Z8');
    expect(location?.sourceContextId).toBe('c2');
    expect(out.find((s) => s.kind === 'fill' && s.fieldId === 'f0')?.value).toBe('Dinner at Seven Shores Cafe');
  });

  it('fills a Gmail To field with an email seen in Slack', async () => {
    const out = await local.suggest(fixture('slack-gmail-to').request, { signal });
    expect(out).toEqual([expect.objectContaining({ kind: 'fill', fieldId: 'f0', value: 'maya.chen@northbrookstudio.com' })]);
  });

  it('returns [] on every negative fixture', async () => {
    for (const f of fixtures.values()) {
      if (f.expect.length > 0) continue;
      const out = await local.suggest(f.request, { signal });
      expect(judge(f, out), f.name).toEqual({ pass: true, detail: '[]' });
    }
  });

  it('returns [] when the signal is already aborted', async () => {
    expect(await local.suggest(fixture('discord-maps-search').request, { signal: AbortSignal.abort() })).toEqual([]);
  });

  it('never suggests into a field that already has a value', async () => {
    const req = fixture('discord-maps-search').request;
    const out = await local.suggest({ ...req, fields: [{ ...req.fields[0]!, v: 'sushi' }] }, { signal });
    expect(out).toEqual([]);
  });

  // The orchestrator lists a selected Discord snippet ahead of the newer Maps page (selection x3),
  // so the address must win on merit, not on position.
  it('prefers the street address for a location field whichever context item comes first', async () => {
    const req = fixture('maps-calendar-location').request;
    const out = await local.suggest({ ...req, context: [...req.context].reverse() }, { signal });
    const location = out.find((s) => s.kind === 'fill' && s.fieldId === 'f1');
    expect(location?.value).toBe('10 Regina St N, Waterloo, ON N2J 2Z8');
    expect(location?.sourceContextId).toBe('c2');
  });

  it('never fills a login username box with an email seen elsewhere', async () => {
    const login = fixture('neg-blank-login').request;
    const out = await local.suggest({ ...login, context: fixture('slack-gmail-to').request.context }, { signal });
    expect(out).toEqual([]);
  });
});

describe('LocalProvider actions', () => {
  it('offers Maps and Calendar for the invitation on the Discord page itself', async () => {
    const out = await local.suggest(fixture('discord-open-maps').request, { signal });
    expect(out).toEqual([
      { kind: 'action', intent: 'maps', value: 'Seven Shores Cafe', when: '', location: '', confidence: 0.75, reason: expect.any(String), sourceContextId: 'o1' },
      {
        kind: 'action',
        intent: 'calendar',
        value: 'Dinner at Seven Shores Cafe',
        when: '2026-09-18T18:00:00-04:00',
        location: 'Seven Shores Cafe',
        confidence: 0.75,
        reason: expect.any(String),
        sourceContextId: 'o1',
      },
    ]);
  });

  it('offers Gmail when the page asks the reader to email someone', async () => {
    const out = await local.suggest(fixture('slack-compose-gmail').request, { signal });
    expect(out).toEqual([expect.objectContaining({ kind: 'action', intent: 'gmail', value: 'maya.chen@northbrookstudio.com', sourceContextId: 'o1' })]);
  });

  it('takes actions only from the page being read, never from other tabs', async () => {
    const discord = fixture('discord-open-maps').request;
    const asContext: SuggestRequest = { ...discord, page: { host: 'news.ycombinator.com', title: 'HN', path: '/' }, context: discord.own!, own: [] };
    expect(await local.suggest(asContext, { signal })).toEqual([]);
  });

  it('never offers the destination the user is already on', async () => {
    const discord = fixture('discord-open-maps').request;
    const onMaps: SuggestRequest = { ...discord, page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' } };
    const out = await local.suggest(onMaps, { signal });
    expect(out.map((s) => s.kind === 'action' && s.intent)).toEqual(['calendar']);
    const onCalendar: SuggestRequest = { ...discord, page: { host: 'calendar.google.com', title: 'Calendar', path: '/calendar/u/0/r' } };
    expect((await local.suggest(onCalendar, { signal })).map((s) => s.kind === 'action' && s.intent)).toEqual(['maps']);
  });

  it('uses a street address as the Calendar location when the page has one', async () => {
    const req = fixture('discord-open-maps').request;
    const own = [{ ...req.own![0]!, text: `${req.own![0]!.text} alex 2:05 PM address is 10 Regina St N, Waterloo, ON N2J 2Z8` }];
    const out = await local.suggest({ ...req, own }, { signal });
    expect(out.find((s) => s.kind === 'action' && s.intent === 'calendar')).toMatchObject({ location: '10 Regina St N, Waterloo, ON N2J 2Z8' });
  });
});

describe('extract', () => {
  it('finds planned places and strips trailing time words', () => {
    expect(extractPlace('lunch at Vincenzos Saturday?')).toEqual({ name: 'Vincenzos', activity: 'lunch' });
    expect(extractPlace('meet at Union Station Friday at 6')).toEqual({ name: 'Union Station', activity: 'meet' });
    expect(extractPlace('let\'s try "Loloan Lobby Bar" this week')).toEqual({ name: 'Loloan Lobby Bar' });
    expect(extractPlace('the council voted at Regional Headquarters on Tuesday')).toBeNull();
  });

  it('ignores news prose: quoted dialogue and "will be at <Place>"', () => {
    expect(extractPlace('"This is unacceptable," the mayor told reporters on Tuesday.')).toBeNull();
    expect(extractPlace('"Not this year;" he added.')).toBeNull();
    expect(extractPlace('"We are ready," said the premier, who will be at Parliament Hill on Monday.')).toBeNull();
  });

  it('requires a capitalised place after "at"', () => {
    expect(extractPlace("let's meet at my place around 7")).toBeNull();
    expect(extractPlace('see you at the game tonight')).toBeNull();
    expect(extractPlace('the increase will be at least 25 cents')).toBeNull();
    expect(extractPlace('Dinner at Seven Shores Cafe, Friday at 6?')).toEqual({ name: 'Seven Shores Cafe', activity: 'dinner' });
  });

  it('only strips whole time words from a place name', () => {
    expect(extractPlace('dinner at The Sunset Grill on Friday?')).toEqual({ name: 'The Sunset Grill', activity: 'dinner' });
    expect(extractPlace('meet at Golden Monkey at 8')).toEqual({ name: 'Golden Monkey', activity: 'meet' });
    expect(extractPlace('drinks at TGI Fridays tomorrow')).toEqual({ name: 'TGI Fridays', activity: 'drinks' });
    expect(extractPlace('brunch at Vincenzos Sat')).toEqual({ name: 'Vincenzos', activity: 'brunch' });
    expect(extractPlace('coffee at Settlement Tuesday morning')).toEqual({ name: 'Settlement', activity: 'coffee' });
  });

  it('does not read the tail of a long number as a phone', () => {
    expect(extractPhone('order 1758046800000 shipped')).toBeNull();
    expect(extractPhone('sevenshores.ca (519) 555-0142 Suggest an edit')).toBe('(519) 555-0142');
    expect(extractPhone('call +1 519-555-0142 today')).toBe('+1 519-555-0142');
  });

  it('matches street addresses with and without a city', () => {
    expect(extractAddress('meet me at 200 University Ave W, Waterloo, ON N2L 3G1 ok')).toBe('200 University Ave W, Waterloo, ON N2L 3G1');
    expect(extractAddress('1600 Pennsylvania Avenue NW, Washington, DC 20500')).toBe('1600 Pennsylvania Avenue NW, Washington, DC 20500');
    expect(extractAddress('turn onto 5th street then')).toBeNull();
    expect(extractAddress('voted 11-5 on Tuesday')).toBeNull();
  });

  it('only treats an email as a request when the text asks for a message', () => {
    expect(extractEmailRequest('can you email them over? her address is maya.chen@northbrookstudio.com')).toBe('maya.chen@northbrookstudio.com');
    expect(extractEmailRequest('send the deck to sam@example.com when done')).toBe('sam@example.com');
    expect(extractEmailRequest('Contact the newsroom: tips@cbc.ca')).toBeNull();
    expect(extractEmailRequest('Unsubscribe: no-reply@example.com')).toBeNull();
  });
});

describe('extractWhen', () => {
  // A Wednesday afternoon in Waterloo.
  const now = '2026-09-16T14:04:00-04:00';

  it('resolves a weekday and time to the coming one, in the offset of now', () => {
    expect(extractWhen(', Friday at 6?', now, 'dinner')).toBe('2026-09-18T18:00:00-04:00');
    expect(extractWhen('fri @ 6:30', now)).toBe('2026-09-18T18:30:00-04:00');
    expect(extractWhen('Saturday 10am', now)).toBe('2026-09-19T10:00:00-04:00');
    expect(extractWhen('Sat 8 p.m.', now)).toBe('2026-09-19T20:00:00-04:00');
  });

  it('handles today, tonight and tomorrow, and a weekday that already passed this week', () => {
    expect(extractWhen('tonight at 9', now)).toBe('2026-09-16T21:00:00-04:00');
    expect(extractWhen('tomorrow at 7', now)).toBe('2026-09-17T19:00:00-04:00');
    expect(extractWhen('Monday at 12', now)).toBe('2026-09-21T12:00:00-04:00');
    expect(extractWhen('Wednesday at 9', now)).toBe('2026-09-16T21:00:00-04:00');
    expect(extractWhen('Wednesday at 1pm', now)).toBe('2026-09-23T13:00:00-04:00');
  });

  it('reads a bare hour as morning only for a morning activity', () => {
    expect(extractWhen('Saturday at 9', now, 'coffee')).toBe('2026-09-19T09:00:00-04:00');
    expect(extractWhen('Saturday at 9', now, 'drinks')).toBe('2026-09-19T21:00:00-04:00');
    expect(extractWhen('Sunday at 11', now, 'brunch')).toBe('2026-09-20T11:00:00-04:00');
  });

  it('ignores a bare number after a day and anything without a day', () => {
    expect(extractWhen('Friday 6 people', now)).toBeNull();
    expect(extractWhen('at 6', now)).toBeNull();
    expect(extractWhen('Friday at 25', now)).toBeNull();
    expect(extractWhen('Friday at 6', 'not a time')).toBeNull();
  });

  it('keeps a UTC now in UTC', () => {
    expect(extractWhen('Friday at 6', '2026-09-16T18:04:00Z')).toBe('2026-09-18T18:00:00+00:00');
  });
});

describe('classifyField', () => {
  it('reads the descriptor, not just the type', () => {
    expect(classifyField({ i: 'f0', t: 'combobox', nm: 'to', al: 'To recipients' })).toBe('email');
    expect(classifyField({ i: 'f0', t: 'input:text', al: 'Add location' })).toBe('location');
    expect(classifyField({ i: 'f0', t: 'input:text', al: 'Add title' })).toBe('title');
    expect(classifyField({ i: 'f0', t: 'textarea', nm: 'q', al: 'Search' })).toBe('search');
    expect(classifyField({ i: 'f0', t: 'input:text', ac: 'tel-national' })).toBe('phone');
    expect(classifyField({ i: 'f0', t: 'textarea', lb: 'Leave a comment' })).toBeNull();
  });

  it('refuses credential and card fields whatever their label says', () => {
    expect(classifyField({ i: 'f0', t: 'input:text', nm: 'login', lb: 'Username or email address', ac: 'username' })).toBeNull();
    expect(classifyField({ i: 'f0', t: 'input:text', lb: 'Email', ac: 'username webauthn' })).toBeNull();
    expect(classifyField({ i: 'f0', t: 'input:text', lb: 'Code', ac: 'one-time-code' })).toBeNull();
    expect(classifyField({ i: 'f0', t: 'input:text', lb: 'Phone', ac: 'cc-number' })).toBeNull();
  });
});
