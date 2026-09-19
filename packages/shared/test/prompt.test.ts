import { describe, expect, it } from 'vitest';
import { FEW_SHOTS, actionInstructions, buildNextActionMessages, renderRequest } from '../src/prompt';
import { EAGERNESS_LEVELS } from '../src/eagerness';
import type { NextActionRequest } from '../src/next-action';

const req: NextActionRequest = {
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps', scroll: { y: 0, pages: 1, more: false } },
  outline: 'search:\n  >> FOCUSED [1] searchbox "Search Google Maps"',
  controls: [{ n: 1, role: 'searchbox', name: 'Search Google Maps' }],
  focused: 1,
  history: ['2m ago: read discord.com/channels/1/2'],
  notes: ['Alex asked about dinner at Seven Shores Cafe on Friday at 6.'],
  tabs: [{ id: 8, host: 'discord.com', title: 'Discord' }],
  now: '2026-09-16T14:04:00-04:00',
  eagerness: 'eager',
  allowPayments: false,
};

describe('buildNextActionMessages', () => {
  it('is byte-stable for the same request', () => {
    expect(JSON.stringify(buildNextActionMessages(req))).toBe(JSON.stringify(buildNextActionMessages(req)));
  });

  it('puts the static instructions and the few-shots before anything from the page', () => {
    const msgs = buildNextActionMessages(req);
    expect(msgs[0]).toEqual({ role: 'system', content: actionInstructions('eager') });
    expect(msgs.slice(1, -1)).toEqual(FEW_SHOTS);
    expect(msgs[msgs.length - 1]!.role).toBe('user');
  });

  it('keeps the instructions identical across requests at the same level', () => {
    const other = buildNextActionMessages({ ...req, now: '2027-01-01T00:00:00Z', notes: [], outline: 'main:' });
    expect(other[0]!.content).toBe(buildNextActionMessages(req)[0]!.content);
  });

  it('changes only the last paragraph with the level', () => {
    const heads = EAGERNESS_LEVELS.map((level) => actionInstructions(level).split('\n\n').slice(0, -1).join('\n\n'));
    expect(new Set(heads).size).toBe(1);
    const tails = EAGERNESS_LEVELS.map((level) => actionInstructions(level).split('\n\n').at(-1));
    expect(new Set(tails).size).toBe(EAGERNESS_LEVELS.length);
  });

  it('forbids "none" at eager and allows it at the quieter levels', () => {
    expect(actionInstructions('eager')).toContain('always suggest an action');
    expect(actionInstructions('balanced')).toContain('"none"');
    expect(actionInstructions('conservative')).toContain('"none"');
  });

  it('ends the user turn with the outline, after the notes, history and tabs', () => {
    const turn = renderRequest(req);
    expect(turn.indexOf('<notes>')).toBeLessThan(turn.indexOf('<history>'));
    expect(turn.indexOf('<history>')).toBeLessThan(turn.indexOf('<tabs>'));
    expect(turn.indexOf('<tabs>')).toBeLessThan(turn.indexOf('<page '));
    expect(turn.trimEnd().endsWith(`${req.outline}\n</page>`)).toBe(true);
  });

  it('says so when a block is empty, rather than leaving it out', () => {
    const turn = renderRequest({ ...req, notes: [], history: [], tabs: [] });
    expect(turn).toContain('<notes>\n(none)\n</notes>');
    expect(turn).toContain('<tabs>\n(none)\n</tabs>');
  });

  it('carries the scroll position and the open tabs the model may switch to', () => {
    const turn = renderRequest({ ...req, page: { ...req.page, scroll: { y: 1.4, pages: 3.2, more: true } } });
    expect(turn).toContain('scroll="1.4 of 3.2 viewports, more below"');
    expect(turn).toContain('- [tab 8] discord.com — Discord');
  });
});
