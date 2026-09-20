import { describe, expect, it } from 'vitest';
import { GHOST_INSTRUCTIONS, GHOST_LIMITS, buildGhostMessages, cleanGhost, ghostMaxTokens } from '../src/ghost-prompt';

const req = {
  prefix: 'Dinner at Seven',
  outline: 'main:\n  [1] textbox "Message"',
  notes: ['Dinner at Seven Shores Cafe on Friday at 6.'],
  singleLine: true,
};

describe('the ghost prompt', () => {
  it('sends the same system string every call, byte for byte', () => {
    const a = buildGhostMessages(req);
    const b = buildGhostMessages({ ...req, prefix: 'something else entirely' });
    expect(a[0]!.content).toBe(b[0]!.content);
    expect(a[0]!.content).toBe(GHOST_INSTRUCTIONS);
    expect(a[0]!.role).toBe('system');
  });

  it('puts the text being typed last, behind the notes and the page', () => {
    const user = buildGhostMessages(req)[1]!.content;
    expect(user.indexOf('<notes>')).toBeLessThan(user.indexOf('<page>'));
    expect(user.indexOf('<page>')).toBeLessThan(user.indexOf('<typed>'));
    expect(user).toContain('Dinner at Seven');
  });

  it('leaves out the caret block and the field name when there are none', () => {
    const user = buildGhostMessages(req)[1]!.content;
    expect(user).not.toContain('<after-caret>');
    expect(user).not.toContain('<field>');
    const withBoth = buildGhostMessages({ ...req, suffix: ' on Friday', field: 'Message' })[1]!.content;
    expect(withBoth).toContain('<after-caret>\n on Friday\n</after-caret>');
    expect(withBoth).toContain('<field>Message</field>');
  });

  it('says "(none)" rather than an empty notes block', () => {
    expect(buildGhostMessages({ ...req, notes: [] })[1]!.content).toContain('<notes>\n(none)\n</notes>');
  });

  it('caps a one-line field harder than a multi-line one', () => {
    expect(ghostMaxTokens(true)).toBe(GHOST_LIMITS.singleLineTokens);
    expect(ghostMaxTokens(false)).toBe(GHOST_LIMITS.multiLineTokens);
    expect(GHOST_LIMITS.singleLineTokens).toBeLessThan(GHOST_LIMITS.multiLineTokens);
  });
});

describe('cleaning what the model wrote', () => {
  it('keeps the leading space the continuation needs', () => {
    expect(cleanGhost(' Shores Cafe', true)).toBe(' Shores Cafe');
  });

  it('drops quotes the model wrapped it in', () => {
    expect(cleanGhost('"Shores Cafe"', true)).toBe('Shores Cafe');
    expect(cleanGhost('“Shores Cafe”', true)).toBe('Shores Cafe');
  });

  it('drops a leading quote on its own, so a partial reads right mid-stream', () => {
    expect(cleanGhost('"Shores', true)).toBe('Shores');
  });

  it('strips code fences', () => {
    expect(cleanGhost('```\nShores Cafe\n```', false)).toBe('Shores Cafe');
  });

  it('cuts a one-line field at the first newline', () => {
    expect(cleanGhost(' Shores Cafe\nand then some', true)).toBe(' Shores Cafe');
    expect(cleanGhost(' Shores Cafe\nand then some', false)).toBe(' Shores Cafe\nand then some');
  });

  it('caps the length as a backstop for a model that ignored the token limit', () => {
    expect(cleanGhost('x'.repeat(500), true)).toHaveLength(GHOST_LIMITS.singleLineChars);
    expect(cleanGhost('x'.repeat(500), false)).toHaveLength(GHOST_LIMITS.multiLineChars);
  });

  it('leaves nothing as nothing', () => {
    expect(cleanGhost('', true)).toBe('');
    expect(cleanGhost('\n\n', false)).toBe('');
  });
});
