import { beforeAll, describe, expect, it } from 'vitest';
import type { SuggestRequest } from '@carat/shared';
import { EAGERNESS_LEVELS } from '@carat/shared';
import { LocalProvider } from '../src/local';
import { classifyField } from '../src/local/fields';
import { affirms, amountFor } from '../src/local/interact';
import { extractAddress, extractEmailRequest, extractName, extractPhone, extractPlace, extractWhen } from '../src/local/extract';
import { expectationsAt, judge, loadFixtures, type Fixture } from '../eval/fixtures';

const signal = new AbortController().signal;
const local = new LocalProvider();
const at = (level: (typeof EAGERNESS_LEVELS)[number]) => new LocalProvider(level);
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

  it('defaults to eager', () => {
    expect(local.eagerness).toBe('eager');
  });

  it('returns [] on every negative fixture below eager, and at eager only a weak chip where the fixture allows one', async () => {
    for (const level of ['conservative', 'balanced'] as const) {
      for (const f of fixtures.values()) {
        if (expectationsAt(f, level).length > 0) continue;
        const out = await at(level).suggest(f.request, { signal });
        expect(judge(f, out, level), `${f.name} at ${level}`).toEqual({ pass: true, detail: '[]' });
      }
    }
    const weak: string[] = [];
    for (const f of fixtures.values()) {
      if (expectationsAt(f, 'eager').length > 0) continue;
      const out = await at('eager').suggest(f.request, { signal });
      const verdict = judge(f, out, 'eager');
      expect(verdict.pass, `${f.name} at eager: ${verdict.detail}`).toBe(true);
      if (verdict.weak) weak.push(f.name);
      for (const s of out) expect(s.confidence, f.name).toBeLessThan(0.55);
    }
    // The documented cost of eager on this fixture set: two bare names from prose, one Esc each.
    expect(weak).toEqual(['neg-news-search', 'neg-recipe-comment']);
  });

  it('passes every positive fixture at every level, the eager-only ones at eager alone', async () => {
    for (const level of EAGERNESS_LEVELS) {
      for (const f of fixtures.values()) {
        if (expectationsAt(f, level).length === 0) continue;
        const out = await at(level).suggest(f.request, { signal });
        expect(judge(f, out, level).pass, `${f.name} at ${level}`).toBe(true);
      }
    }
    const eagerOnly = [...fixtures.values()].filter((f) => f.expect.length === 0 && f.expectAt?.eager);
    expect(eagerOnly.map((f) => f.name)).toEqual([
      'eager-discord-bare-name-search',
      'eager-selection-single-name-maps',
      'eager-slack-quoted-issue-title',
      'neg-same-tab',
    ]);
  });

  it('marks an eager-only value with a confidence under the balanced floor and a reason that says why', async () => {
    const out = await at('eager').suggest(fixture('eager-discord-bare-name-search').request, { signal });
    expect(out).toEqual([
      { kind: 'fill', fieldId: 'f0', value: 'Lazeez Shawarma', confidence: 0.45, reason: 'capitalised name in recent text, no cue around it', sourceContextId: 'c1' },
    ]);
    // A cued place still wins over a bare name for the same field, at full confidence.
    const both = { ...fixture('eager-discord-bare-name-search').request, context: [fixture('discord-maps-search').request.context[0]!, ...fixture('eager-discord-bare-name-search').request.context] };
    expect((await at('eager').suggest(both, { signal })).map((s) => [s.value, s.confidence])).toEqual([['Seven Shores Cafe', 0.75]]);
  });

  it('reads another tab on the page\'s own site at eager and nowhere else', async () => {
    const req = fixture('neg-same-tab').request;
    expect((await at('eager').suggest(req, { signal })).map((s) => s.value)).toEqual(['Seven Shores Cafe']);
    expect(await at('balanced').suggest(req, { signal })).toEqual([]);
    expect(await at('conservative').suggest(req, { signal })).toEqual([]);
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

describe('LocalProvider interactions', () => {
  it('offers the primary Save button after carat filled fields on the page, citing the fill source', async () => {
    const out = await local.suggest(fixture('calendar-save-after-fills').request, { signal });
    expect(out).toEqual([
      { kind: 'interact', elementId: 'e0', verb: 'click', value: 'Save', confidence: 0.75, reason: expect.any(String), sourceContextId: 'c2' },
    ]);
  });

  it('offers no button at all when carat filled nothing, whatever the text says', async () => {
    const req = fixture('calendar-save-after-fills').request;
    const { filled: _f, ...unfilled } = req;
    expect(await local.suggest(unfilled, { signal })).toEqual([]);
    expect(await local.suggest({ ...req, filled: [] }, { signal })).toEqual([]);
  });

  it('checks the box whose name a context sentence affirms, and only that one', async () => {
    const out = await local.suggest(fixture('form-vegetarian-checkbox').request, { signal });
    expect(out).toEqual([expect.objectContaining({ kind: 'interact', elementId: 'e0', verb: 'check', value: 'Vegetarian', sourceContextId: 'c1' })]);
  });

  it('sets the slider named with an amount, snapped to its step and range', async () => {
    const out = await local.suggest(fixture('settings-volume-slider').request, { signal });
    expect(out).toEqual([expect.objectContaining({ kind: 'interact', elementId: 'e0', verb: 'set', value: '40', sourceContextId: 'c1' })]);
  });

  it('never clicks a destructive name, even as the primary action after fills', async () => {
    expect(await local.suggest(fixture('neg-delete-with-matching-text').request, { signal })).toEqual([]);
    expect(await local.suggest(fixture('neg-gmail-send').request, { signal })).toEqual([]);
  });

  it('does not check a box on a generic name, a negated sentence, or a box already on', async () => {
    const req = fixture('form-vegetarian-checkbox').request;
    const ctx = req.context[0]!;
    const withText = (text: string, elements = req.elements!) => ({ ...req, elements, context: [{ ...ctx, text }] });
    const out = async (r: typeof req) => (await local.suggest(r, { signal })).map((s) => s.kind === 'interact' && `${s.elementId}.${s.verb}`);

    expect(await out(withText("I'm not a vegetarian, but Sam is vegan"))).toEqual(['e1.check']);
    expect(await out(withText('no vegetarian options there sadly'))).toEqual([]);
    expect(await out(withText('vegetarian', [{ i: 'e0', r: 'checkbox', nm: 'Yes', st: 'off' }]))).toEqual([]);
    expect(await out(withText('yes I am', [{ i: 'e0', r: 'checkbox', nm: 'Yes', st: 'off' }]))).toEqual([]);
    expect(await out(withText("I'm a vegetarian", [{ i: 'e0', r: 'checkbox', nm: 'Vegetarian', st: 'on' }]))).toEqual([]);
    expect(await out(withText('the vegetarianism debate', [{ i: 'e0', r: 'checkbox', nm: 'Vegetarian', st: 'off' }]))).toEqual([]);
  });

  it('takes interactions only from other tabs, never from the page itself', async () => {
    const req = fixture('form-vegetarian-checkbox').request;
    expect(await local.suggest({ ...req, context: [], own: req.context }, { signal })).toEqual([]);
  });
});

describe('affirms and amountFor', () => {
  it('matches whole words without negation nearby', () => {
    expect(affirms("I'm a vegetarian", 'Vegetarian')).toBe(true);
    expect(affirms('Gluten free please', 'Gluten free')).toBe(true);
    expect(affirms('gluten-free please', 'Gluten free')).toBe(false);
    expect(affirms("I don't need parking", 'Needs parking')).toBe(false);
    expect(affirms('not vegetarian. vegan though', 'Vegan')).toBe(true);
  });

  it('reads an amount after or before the name and scales percentages to the range', () => {
    const volume = { i: 'e0', r: 'slider' as const, nm: 'Volume', min: 0, max: 100, step: 1 };
    expect(amountFor('turn the volume to 40%', volume)).toBe('40');
    expect(amountFor('volume at 55 please', volume)).toBe('55');
    expect(amountFor('set it to 40% volume', volume)).toBe('40');
    expect(amountFor('volume up a bit', volume)).toBeNull();
    expect(amountFor('the volume was fine. 40 people came', volume)).toBeNull();
    expect(amountFor('volume to 140', volume)).toBe('100');
    const balance = { i: 'e1', r: 'slider' as const, nm: 'Balance', min: -50, max: 50, step: 5 };
    expect(amountFor('balance to 75%', balance)).toBe('25');
    expect(amountFor('balance to 12', balance)).toBe('10');
    const brightness = { i: 'e2', r: 'slider' as const, nm: 'Brightness', min: 0, max: 1, step: 0.1 };
    expect(amountFor('brightness to 70%', brightness)).toBe('0.7');
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

describe('extractName', () => {
  it('takes the most recent run of capitalised words, skipping sentence openers and author stamps', () => {
    expect(extractName('alex 7:02 PM anyone been to Lazeez Shawarma? sam 7:03 PM not yet')).toBe('Lazeez Shawarma');
    expect(extractName('we could do Lazeez Shawarma or maybe Kinkaku Izakaya instead')).toBe('Kinkaku Izakaya');
    expect(extractName('Regional Headquarters hosts the meeting. Staff said so.')).toBeNull();
    expect(extractName('Maya Chen 3:12 PM can you email the deck')).toBeNull();
    expect(extractName('The chair will be at Parliament Hill on Monday')).toBe('Parliament Hill');
  });

  it('ignores page chrome, street parts and short capitals, and does not cross a full stop', () => {
    expect(extractName('Seven Shores Cafe 4.6 (312) Cafe 10 Regina St N, Waterloo, ON N2J 2Z8 Open Closes 9 p.m. Directions Save Share')).toBeNull();
    expect(extractName('native to regions from Central Africa to Southeast Asia. In temperate climates')).toBe('Southeast Asia');
    expect(extractName('meet at The Sunset Grill later')).toBe('The Sunset Grill');
    expect(extractName('nothing capitalised here at all')).toBeNull();
  });

  it('accepts a single capitalised word only from a selection', () => {
    expect(extractName('has anyone tried Vincenzos for lunch', 'selection')).toBe('Vincenzos');
    expect(extractName('Vincenzos', 'selection')).toBe('Vincenzos');
    expect(extractName('has anyone tried Vincenzos for lunch', 'page')).toBeNull();
    expect(extractName('Anyone around Tuesday', 'selection')).toBeNull();
  });

  it('takes a lowercase quoted string as a place only when loose', () => {
    expect(extractPlace('open an issue called "flaky login test on ci" please', true)).toEqual({ name: 'flaky login test on ci' });
    expect(extractPlace('open an issue called "flaky login test on ci" please')).toBeNull();
    expect(extractPlace('"this is unacceptable," she said', true)).toBeNull();
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
