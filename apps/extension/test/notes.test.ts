import { describe, expect, it } from 'vitest';
import { renderNotes, transientReason, type Note } from '../src/engine/background/notes';

const body = 'x'.repeat(400);

function page(over: Partial<{ url: string; title: string; text: string }> = {}) {
  return { url: 'https://reader.test/articles/transit-budget', title: 'Transit budget explained', text: body, ...over };
}

describe('transientReason', () => {
  it('keeps a page the user actually read', () => {
    expect(transientReason(page())).toBeNull();
  });

  it('drops the redirect hop that produced "Redirecting… | Slack"', () => {
    expect(transientReason(page({ title: 'Redirecting… | Slack' }))).toBe('a redirect or loading title');
  });

  it('drops a page that is still loading', () => {
    expect(transientReason(page({ title: 'Loading…' }))).toBe('a redirect or loading title');
  });

  it('drops a page whose title is only the site name', () => {
    expect(transientReason(page({ url: 'https://app.slack.test/client', title: 'Slack' }))).toBe(
      'the title is only the site name',
    );
  });

  it('drops the hops a sign-in makes', () => {
    for (const url of [
      'https://auth.example.test/oauth2/authorize?x=1',
      'https://example.test/login',
      'https://example.test/sso/callback',
    ]) {
      expect(transientReason(page({ url }))).toBe('a sign-in or callback hop');
    }
  });

  it('drops a page with too little text to have been read', () => {
    expect(transientReason(page({ text: 'Redirecting you now.' }))).toBe('too little text to have been read');
  });

  it('drops a page with no title at all', () => {
    expect(transientReason(page({ title: '   ' }))).toBe('no title');
  });
});

const MIN = 60_000;

function note(text: string, minutesAgo: number, over: Partial<Note> = {}): Note {
  return {
    at: 1_000 * MIN - minutesAgo * MIN,
    source: 'read',
    url: 'https://mail.test/u/0',
    title: 'Re: your order',
    text,
    ...over,
  };
}

const NOW = 1_000 * MIN;

describe('renderNotes', () => {
  it('dates every note at the front of its line', () => {
    const out = renderNotes([note('the order arrived torn', 3)], NOW);
    expect(out).toBe('- 3m ago, read on mail.test ("Re: your order"): the order arrived torn');
  });

  it('says where a heard note came from without a host', () => {
    const out = renderNotes([note('someone asked for the invoice', 0, { source: 'heard', url: '', title: '' })], NOW);
    expect(out).toBe('- just now, heard: someone asked for the invoice');
  });

  it('keeps at most two notes older than half an hour', () => {
    const notes = [note('old one', 55), note('old two', 50), note('old three', 40), note('fresh', 2)];
    const lines = renderNotes(notes, NOW).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('old one');
    expect(lines.join('\n')).toContain('old three');
    expect(lines.join('\n')).toContain('fresh');
  });

  it('leaves recent notes alone however many there are', () => {
    const notes = Array.from({ length: 6 }, (_, i) => note(`note ${i}`, i));
    expect(renderNotes(notes, NOW).split('\n')).toHaveLength(6);
  });

  it('says so when there is nothing', () => {
    expect(renderNotes([], NOW)).toBe('(none)');
  });
});
