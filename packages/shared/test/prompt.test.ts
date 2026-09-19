import { describe, expect, it } from 'vitest';
import { SuggestionListSchema } from '../src/schema';
import { FEW_SHOTS, SYSTEM_PROMPT, buildMessages, systemPrompt } from '../src/prompt';
import { EAGERNESS_LEVELS } from '../src/eagerness';
import type { SuggestRequest } from '../src/types';

const req: SuggestRequest = {
  page: { host: 'www.google.com', title: 'Google Maps', path: '/maps' },
  fields: [{ i: 'f0', t: 'input:text', al: 'Search Google Maps', f: 1 }],
  context: [
    {
      id: 'c9',
      origin: 'https://discord.com',
      title: 'Discord',
      kind: 'page',
      text: 'dinner at Seven Shores Cafe, Friday at 6?',
      capturedAt: 1,
    },
  ],
  now: '2026-09-16T14:04:00-04:00',
};

describe('buildMessages', () => {
  it('is deterministic for the same request', () => {
    const a = buildMessages(req);
    const b = buildMessages(req);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('starts with the shared system prompt and ends with the request', () => {
    const msgs = buildMessages(req);
    expect(msgs[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(msgs.slice(1, -1)).toEqual(FEW_SHOTS);
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe('user');
    expect(JSON.parse(last.content)).toEqual(req);
  });

  it('keeps the system prompt identical across different requests', () => {
    const other = buildMessages({ ...req, now: '2027-01-01T00:00:00Z', context: [] });
    expect(other[0]!.content).toBe(buildMessages(req)[0]!.content);
  });

  it('changes only the last rule with the level, and keeps each level byte-identical across requests', () => {
    const prompts = EAGERNESS_LEVELS.map((l) => systemPrompt(l));
    expect(new Set(prompts).size).toBe(3);
    const head = (p: string) => p.slice(0, p.lastIndexOf('\n13. '));
    expect(new Set(prompts.map(head)).size).toBe(1);
    expect(head(prompts[0]!)).toContain('10. A context item with `kind` "vision"');
    expect(head(prompts[0]!)).toContain('11. Propose `scroll` only');
    expect(head(prompts[0]!)).toContain("12. The one exception to rule 9's fill requirement: a real link");
    for (const l of EAGERNESS_LEVELS) {
      expect(buildMessages(req, l)[0]!.content).toBe(systemPrompt(l));
      expect(buildMessages({ ...req, context: [] }, l)[0]!.content).toBe(systemPrompt(l));
      expect(buildMessages(req, l).slice(1, -1)).toEqual(FEW_SHOTS);
    }
    expect(SYSTEM_PROMPT).toBe(systemPrompt('eager'));
  });

  it('tells the conservative model to stay quiet and the eager one to propose, with the invariant rules in both', () => {
    expect(systemPrompt('conservative')).toMatch(/13\. When unsure, return an empty list\. No suggestion beats a wrong one\./);
    expect(systemPrompt('eager')).toMatch(/13\. Lean toward proposing/);
    expect(systemPrompt('eager')).toMatch(/Return an empty list only when nothing in the context relates/);
    expect(systemPrompt('balanced')).toMatch(/propose the likelier one/);
    for (const l of EAGERNESS_LEVELS) {
      const p = systemPrompt(l);
      expect(p).toContain('5. An address belongs in a location field.');
      expect(p).toContain("7. Text from `own` may fill a field on that page, but the page's own furniture may not");
      expect(p).toContain('never propose a field\'s own label, placeholder, aria-label or current value');
      expect(p).toContain('Never propose generic words.');
    }
  });

  it('ships few-shot answers that satisfy the output schema', () => {
    for (const m of FEW_SHOTS.filter((m) => m.role === 'assistant')) {
      expect(SuggestionListSchema.safeParse(JSON.parse(m.content)).success).toBe(true);
    }
  });

  it('describes the page state and the next-step priors, and shows the results page as a few-shot with no context', () => {
    const p = systemPrompt('balanced');
    expect(p).toContain('`state` (the page as a whole');
    expect(p).toContain('Next step. Text from other tabs is one input, not a precondition');
    expect(p).toContain('- serp: `click` the result link whose host or title matches `q`');
    expect(p).toContain('`elementId` "" move the page one viewport down');
    const serp = FEW_SHOTS.findIndex((m) => m.role === 'user' && JSON.parse(m.content).state?.kind === 'serp');
    expect(serp).toBeGreaterThan(0);
    expect(JSON.parse(FEW_SHOTS[serp]!.content).context).toEqual([]);
    expect(JSON.parse(FEW_SHOTS[serp + 1]!.content).suggestions).toEqual([
      expect.objectContaining({ kind: 'interact', elementId: 'e1', verb: 'click', sourceContextId: 'page' }),
    ]);
  });
});
