import { describe, expect, it } from 'vitest';
import { SuggestionListSchema } from '../src/schema';
import { FEW_SHOTS, SYSTEM_PROMPT, buildMessages } from '../src/prompt';
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

  it('ships few-shot answers that satisfy the output schema', () => {
    for (const m of FEW_SHOTS.filter((m) => m.role === 'assistant')) {
      expect(SuggestionListSchema.safeParse(JSON.parse(m.content)).success).toBe(true);
    }
  });
});
