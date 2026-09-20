import { describe, expect, it, vi } from 'vitest';
import { createElasticMemory } from '../src/background/elastic';
import { DEFAULT_SETTINGS } from '../src/engine/shared/settings';

/** A cluster that keeps one task doc in memory, so a whole flow can run against it. */
function cluster() {
  let task: Record<string, unknown> | null = null;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    if (init?.method === 'DELETE') { task = null; return Response.json({ result: 'deleted' }); }
    if (init?.method === 'GET') return task ? Response.json({ _source: task }) : new Response(null, { status: 404 });
    if (init?.method === 'PUT' && path.includes('-tasks/_doc/')) {
      task = JSON.parse(String(init.body));
      return Response.json({ result: 'updated' });
    }
    if (path.includes('-tasks/_search')) return Response.json({ hits: { hits: task ? [{ _source: task }] : [] } });
    return Response.json({ hits: { hits: [] } });
  });
  return { fetchImpl, peek: () => task };
}

describe('task survives the journey', () => {
  it('carries a calendar plan from Discord through a switch and three fills', async () => {
    const { fetchImpl, peek } = cluster();
    const elastic = createElasticMemory({
      settings: async () => ({ ...DEFAULT_SETTINGS, elasticUrl: 'https://es.example.com', elasticApiKey: 'k', elasticIndexPrefix: 'caret' }),
      fetchImpl,
    });

    await elastic.indexFacts(
      { id: 'ctx-1', tabId: 2, url: 'https://discord.com/channels/1', title: 'Discord', text: 'x', at: Date.now() },
      [{ at: Date.now(), source: 'read', url: 'https://discord.com/channels/1', title: 'Discord', text: 'Dinner at Seven Shores Cafe on Friday at 6.' }],
    );
    const names = () => (peek()?.fields as Array<{ name: string; done: boolean }> ?? []);
    // The plan names a title, a day and a place, so the calendar has three fields to fill.
    expect(names().map((f) => f.name).sort()).toEqual(['location', 'title', 'when']);

    // Travelling to the surface must not consume the task: this is the bug
    // where Caret switched tabs and then had nothing left to type.
    await elastic.recordAction({ tabId: 5, host: 'calendar.google.com', kind: 'open', label: 'Open Google Calendar', value: 'https://calendar.google.com', accepted: true });
    expect(peek()).not.toBeNull();
    expect(names().filter((f) => !f.done)).toHaveLength(3);

    for (const [label, value] of [
      ['Fill Title with "Dinner at Seven Shores Cafe"', 'Dinner at Seven Shores Cafe'],
      ['Fill Starts with "Friday at 6"', 'Friday at 6'],
      ['Fill Location with "Seven Shores Cafe"', 'Seven Shores Cafe'],
    ] as const) {
      const before = names().filter((f) => !f.done).length;
      await elastic.recordAction({ tabId: 5, host: 'calendar.google.com', kind: 'fill', label, value, accepted: true });
      // Each fill spends exactly one field, never more.
      if (peek()) expect(names().filter((f) => !f.done)).toHaveLength(before - 1);
    }
    // The last field closes the task out.
    expect(peek()).toBeNull();
  });
});
