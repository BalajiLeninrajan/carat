import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/prompt';
import { EXAMPLES, EXAMPLE_VALUES, WARMUP_OUTLINE, actionInstructions, buildNextActionMessages, buildWarmupMessages, renderPrefix, renderRequest } from '../src/prompt';
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
};

const GOAL = 'book a flight ZRH to LON on Friday, cheapest';

describe('buildNextActionMessages', () => {
  it('is byte-stable for the same request', () => {
    expect(JSON.stringify(buildNextActionMessages(req))).toBe(JSON.stringify(buildNextActionMessages(req)));
  });

  it('puts the static instructions and the examples before anything from the page', () => {
    const msgs = buildNextActionMessages(req);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'system', content: actionInstructions('eager') });
    expect(msgs[0]!.content).toContain(EXAMPLES);
    expect(msgs[1]!.role).toBe('user');
    // Nothing invented is in a user or assistant turn, where the model reads
    // its own history and takes what it finds for something this user did.
    expect(msgs[1]!.content).not.toContain('<examples>');
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

  it('weighs the page and the newest lines above an old note, at every level', () => {
    for (const level of EAGERNESS_LEVELS) {
      const text = actionInstructions(level);
      expect(text).toContain('Evidence, in order of weight');
      expect(text).toContain('A note from long ago or from an unrelated site is weak evidence');
      expect(text).toContain('If the page gives no reason to type a particular value, do not fill');
      expect(text).toContain('a search box on an unrelated site is not a place for a note about dinner');
      expect(text).toContain('A page title, a site name, a tab name');
      expect(text).toContain('the next step is almost never a search fill');
      // And it says so before it says anything else about choosing.
      expect(text.indexOf('Evidence, in order of weight')).toBeLessThan(text.indexOf('<goal> is what the user'));
    }
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

  it('puts the goal at the head of the prefix, in front of the notes', () => {
    const turn = renderRequest({ ...req, goal: GOAL });
    expect(turn).toContain(`<goal>\n${GOAL}\n</goal>`);
    expect(turn.indexOf('<goal>')).toBeLessThan(turn.indexOf('<notes>'));
    // And nowhere near the page, which is what a request pays for twice.
    expect(turn.indexOf('<goal>')).toBeLessThan(turn.indexOf('<page '));
  });

  it('leaves the block out entirely when carat has no goal, so those requests send the bytes they always did', () => {
    expect(renderRequest(req)).not.toContain('<goal>');
    expect(renderPrefix({ ...req, goal: '   ' })).toBe(renderPrefix(req));
  });

  it('says so when a block is empty, rather than leaving it out', () => {
    const turn = renderRequest({ ...req, notes: [], history: [], tabs: [] });
    expect(turn).toContain('<notes>\n(none)\n</notes>');
    expect(turn).toContain('<tabs>\n(none)\n</tabs>');
  });

  it('leaves where the page is scrolled to the outline, which measures what it described', () => {
    const turn = renderRequest({ ...req, page: { ...req.page, scroll: { y: 1.4, pages: 3.2, more: true } } });
    expect(turn).not.toContain('scroll=');
    expect(turn).toContain('<page host="www.google.com" path="/maps">');
    // The example the model learns the shape from carries the outline's own lines instead.
    expect(EXAMPLES).toContain('(0.8 screens above)');
    expect(EXAMPLES).toContain('more screens below;');
  });

  it('carries the open tabs the model may switch to', () => {
    expect(renderRequest(req)).toContain('- [tab 8] discord.com — Discord');
  });

  it('keeps the clock out of the prefix, so a second on the clock cannot miss the cache', () => {
    const turn = renderRequest(req);
    expect(turn.indexOf('</tabs>')).toBeLessThan(turn.indexOf('<now>'));
    expect(renderPrefix(req)).not.toContain('<now>');
  });
});

describe('the warm-up request', () => {
  it('sends the prefix byte for byte, so the real request hits the cache', () => {
    const warm = buildWarmupMessages(req);
    const real = buildNextActionMessages(req);
    // Everything before the page turn is one string, identical in both.
    expect(JSON.stringify(warm.slice(0, -1))).toBe(JSON.stringify(real.slice(0, -1)));

    const prefix = renderPrefix(req);
    const warmTurn = warm.at(-1)!.content;
    const realTurn = real.at(-1)!.content;
    expect(warmTurn.slice(0, prefix.length)).toBe(prefix);
    expect(realTurn.slice(0, prefix.length)).toBe(prefix);

    // And byte for byte across the whole prompt up to where the page begins.
    const head = (msgs: ChatMessage[]): string => msgs.map((m) => `${m.role}\n${m.content}`).join('\n').split('<now>')[0]!;
    expect(head(warm)).toBe(head(real));
  });

  it('carries the goal too, so the bytes still match once carat has one', () => {
    const withGoal = { ...req, goal: GOAL };
    const warm = buildWarmupMessages(withGoal);
    const real = buildNextActionMessages(withGoal);
    expect(JSON.stringify(warm.slice(0, -1))).toBe(JSON.stringify(real.slice(0, -1)));
    const prefix = renderPrefix(withGoal);
    expect(real.at(-1)!.content.slice(0, prefix.length)).toBe(prefix);
    expect(warm.at(-1)!.content.slice(0, prefix.length)).toBe(prefix);
    // A goal that changes is a prefix that changes: the one cache miss this costs.
    expect(prefix).not.toBe(renderPrefix(req));
  });

  it('is the same bytes whatever the outline and the clock were', () => {
    const a = buildWarmupMessages(req);
    const b = buildWarmupMessages({ ...req, outline: 'something else entirely', controls: [], now: req.now });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.at(-1)!.content).toContain(WARMUP_OUTLINE);
  });

  it('moves with the notes, the history and the tabs, because the real request will too', () => {
    const other = buildWarmupMessages({ ...req, notes: ['Something else was read.'] });
    expect(other.at(-1)!.content).not.toBe(buildWarmupMessages(req).at(-1)!.content);
  });
});

describe('the examples', () => {
  it('open with the line that says they are examples and nothing else', () => {
    const [open, first] = EXAMPLES.split('\n');
    expect(open).toBe('<examples>');
    expect(first).toContain('illustrations of the format and the reasoning only');
    expect(first).toContain('Nothing in them is about the current user');
    expect(first).toContain('Never reuse a value from an example');
    expect(EXAMPLES.endsWith('</examples>')).toBe(true);
  });

  it('is made of values nobody would ever type', () => {
    // The cafe the owner kept finding in their search boxes, and the rest of
    // the real-looking cast it arrived with.
    const REAL_LOOKING = /seven shores|sevenshores|reddit\.com|discord\.com|google\.com|acme\.com|waterloo|mcmaster|regina st/i;
    for (const level of EAGERNESS_LEVELS) expect(actionInstructions(level)).not.toMatch(REAL_LOOKING);
    // Every host in an example is under a reserved TLD, so none of them resolves.
    for (const host of EXAMPLES.match(/host="([^"]+)"/g) ?? []) expect(host).toMatch(/\.test"$/);
  });

  it('lists every value it uses, so the fill check cannot drift from the text', () => {
    for (const value of EXAMPLE_VALUES) expect(EXAMPLES + actionInstructions('eager')).toContain(value);
  });
});
