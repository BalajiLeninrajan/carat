import { beforeAll, describe, expect, it } from 'vitest';
import { candidatesFrom, extractCandidates } from '../src/local/candidates';
import { loadFixtures, type Fixture } from '../eval/fixtures';

let fixtures: Map<string, Fixture>;
beforeAll(async () => {
  fixtures = new Map((await loadFixtures()).map((f) => [f.name, f]));
});
const context = (name: string) => fixtures.get(name)!.request.context;

describe('extractCandidates on the fixtures', () => {
  it('finds the planned place and the composed title in the Discord thread', () => {
    expect(extractCandidates(context('discord-maps-search'))).toEqual([
      { kind: 'place', value: 'Seven Shores Cafe', sourceContextId: 'c1', activity: 'dinner' },
      { kind: 'plan', value: 'Dinner at Seven Shores Cafe', sourceContextId: 'c1' },
    ]);
  });

  it('keeps each candidate tied to the context item it came from', () => {
    const found = extractCandidates(context('maps-calendar-location'));
    expect(found).toEqual([
      { kind: 'phone', value: '(519) 555-0142', sourceContextId: 'c2' },
      { kind: 'address', value: '10 Regina St N, Waterloo, ON N2J 2Z8', sourceContextId: 'c2' },
      { kind: 'place', value: 'Seven Shores Cafe', sourceContextId: 'c2' },
      { kind: 'plan', value: 'Dinner at Seven Shores Cafe', sourceContextId: 'c1' },
    ]);
  });

  it('finds the email in Slack and the event name in the article', () => {
    expect(extractCandidates(context('slack-gmail-to'))).toEqual([
      { kind: 'email', value: 'maya.chen@northbrookstudio.com', sourceContextId: 'c1' },
    ]);
    expect(extractCandidates(context('article-calendar-title'))).toEqual([
      { kind: 'event', value: 'Waterloo Busker Carnival', sourceContextId: 'c1' },
    ]);
  });

  it('finds nothing in the news story, the encyclopedia page or an empty context', () => {
    for (const name of ['neg-news-search', 'neg-recipe-comment', 'neg-blank-login']) {
      expect(extractCandidates(context(name)), name).toEqual([]);
    }
  });

  it('adds the most recent bare name only when loose, and never one that repeats a cued candidate', () => {
    expect(extractCandidates(context('neg-news-search'), true)).toEqual([{ kind: 'name', value: 'Parliament Hill', sourceContextId: 'c1' }]);
    expect(extractCandidates(context('neg-recipe-comment'), true)).toEqual([{ kind: 'name', value: 'Southeast Asia', sourceContextId: 'c1' }]);
    // "Seven Shores Cafe" is already the planned place, so no `name` doubles it.
    expect(extractCandidates(context('discord-maps-search'), true).map((c) => c.kind)).toEqual(['place', 'plan']);
    // An author stamp is not a name, so the Slack thread still yields the email alone.
    expect(extractCandidates(context('slack-gmail-to'), true).map((c) => c.kind)).toEqual(['email']);
  });

  it('drops an exact repeat after its first source but keeps different kinds of the same text', () => {
    const a = { id: 'a', text: 'lunch at Vincenzos Saturday?' };
    const b = { id: 'b', text: 'see you at Vincenzos' };
    expect(extractCandidates([a, b])).toEqual([
      { kind: 'place', value: 'Vincenzos', sourceContextId: 'a', activity: 'lunch' },
      { kind: 'plan', value: 'Lunch at Vincenzos', sourceContextId: 'a' },
    ]);
    expect(candidatesFrom(b)).toEqual([{ kind: 'place', value: 'Vincenzos', sourceContextId: 'b', activity: 'see you' }]);
  });
});
