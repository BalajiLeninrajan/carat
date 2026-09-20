import { describe, expect, it, vi } from 'vitest';
import { createElasticMemory } from '../src/background/elastic';
import type { Observation, PageContext } from '../src/background/elastic';
import type { Note } from '../src/engine/background/notes';
import type { Settings } from '../src/engine/shared/settings';
import { DEFAULT_SETTINGS } from '../src/engine/shared/settings';

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  elasticUrl: 'https://elastic.example.com',
  elasticApiKey: 'es-key',
  elasticIndexPrefix: 'carat-test',
  ...over,
});

const req = (): PageContext => ({
  url: 'https://calendar.google.com/calendar',
  title: 'Calendar event',
  text: 'main:\n  >> FOCUSED [1] textbox "Title"\n  [2] textbox "Location"',
  candidates: [{ n: 1, backendNodeId: 11, role: 'textbox', name: 'Title' }],
  focused: { role: 'textbox', name: 'Title' },
  history: '10s ago: opened from tab 2',
});

const item = (): Observation => ({
  id: 'ctx-1',
  tabId: 2,
  url: 'https://discord.com/channels/1',
  title: 'Discord',
  text: 'Alex asked about dinner at Seven Shores Cafe on Friday at 6.',
  at: Date.parse('2026-09-19T15:00:00Z'),
});

describe('ElasticMemory', () => {
  it('does nothing when Elasticsearch is not configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const elastic = createElasticMemory({ settings: async () => settings({ elasticUrl: '', elasticApiKey: '' }), fetchImpl });

    expect(await elastic.retrieve(req(), 1)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retrieves compact BM25 evidence lines', async () => {
    let searchBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (String(_url).includes('carat-test-observations,carat-test-facts/_search')) searchBody = JSON.parse(String(init?.body));
      return Response.json({
        hits: {
          hits: [
            {
              _source: {
                kind: 'fact',
                host: 'discord.com',
                at: '2026-09-19T15:00:00Z',
                text: 'Alex asked about dinner at Seven Shores Cafe on Friday at 6.',
              },
            },
          ],
        },
      });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    const lines = await elastic.retrieve(req(), 1);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://elastic.example.com/carat-test-observations,carat-test-facts/_search?ignore_unavailable=true',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(searchBody).toHaveProperty('query');
    expect(searchBody).not.toHaveProperty('retriever');
    expect(JSON.stringify(searchBody)).toContain('"at":{"gte":"now-12h"}');
    expect(lines).toContain('[elasticsearch] fact from discord.com, 2026-09-19T15:00:00Z: Alex asked about dinner at Seven Shores Cafe on Friday at 6.');
    expect(lines.every((line) => !line.includes('DOM capability'))).toBe(true);
  });

  it('creates semantic_text mappings when an inference endpoint is configured', async () => {
    const writes: Array<[string, Record<string, unknown>]> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      if (init?.body) writes.push([String(_url), JSON.parse(String(init.body))]);
      return Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({
      settings: async () => settings({ elasticInferenceId: '.elser-2-elasticsearch' }),
      fetchImpl,
    });
    const notes: Note[] = [
      {
        at: Date.parse('2026-09-19T15:01:00Z'),
        source: 'read',
        url: 'https://discord.com',
        title: 'Discord',
        text: 'Alex asked about dinner at Seven Shores Cafe on Friday at 6.',
      },
    ];

    await elastic.indexFacts(item(), notes);

    const factsMapping = writes.find(([url]) => url === 'https://elastic.example.com/carat-test-facts')?.[1];
    const factsDoc = writes.find(([url]) => url.includes('carat-test-facts/_doc/ctx-1%3A0'))?.[1];
    expect(JSON.stringify(factsMapping)).toContain('"type":"semantic_text"');
    expect(JSON.stringify(factsMapping)).toContain('"inference_id":".elser-2-elasticsearch"');
    expect(factsDoc).toMatchObject({ text_semantic: notes[0]!.text });
  });

  it('supports the semantic_text default endpoint without writing an inference_id', async () => {
    const writes: Array<[string, Record<string, unknown>]> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      if (init?.body) writes.push([String(_url), JSON.parse(String(init.body))]);
      return Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({
      settings: async () => settings({ elasticInferenceId: 'default' }),
      fetchImpl,
    });

    await elastic.indexObservation(item());

    const mapping = writes.find(([url]) => url === 'https://elastic.example.com/carat-test-observations')?.[1];
    const doc = writes.find(([url]) => url.includes('carat-test-observations/_doc/ctx-1'))?.[1];
    expect(JSON.stringify(mapping)).toContain('"type":"semantic_text"');
    expect(JSON.stringify(mapping)).not.toContain('"inference_id"');
    expect(doc).toMatchObject({ text_semantic: item().text });
  });

  it('creates and uses an ingest pipeline for every indexed document', async () => {
    const writes: Array<[string, Record<string, unknown>]> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (init?.body) writes.push([String(url), JSON.parse(String(init.body))]);
      return Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.indexObservation(item());

    const pipeline = writes.find(([url]) => url === 'https://elastic.example.com/_ingest/pipeline/carat-test-carat-ingest')?.[1];
    expect(JSON.stringify(pipeline)).toContain('"received_at"');
    expect(JSON.stringify(pipeline)).toContain('"host_normalized"');
    expect(JSON.stringify(pipeline)).toContain('"[redacted-number]"');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://elastic.example.com/carat-test-observations/_doc/ctx-1?pipeline=carat-test-carat-ingest',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('uses RRF over BM25 and semantic_text when semantic mode is enabled', async () => {
    let searchBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (String(_url).includes('carat-test-observations,carat-test-facts')) searchBody = JSON.parse(String(init?.body));
      return Response.json({ hits: { hits: [] } });
    });
    const elastic = createElasticMemory({
      settings: async () => settings({ elasticInferenceId: 'default' }),
      fetchImpl,
    });

    await elastic.retrieve(req(), 1);

    expect(searchBody).toHaveProperty('retriever');
    expect(JSON.stringify(searchBody)).toContain('"rrf"');
    expect(JSON.stringify(searchBody)).toContain('"text_semantic"');
  });

  it('groups distilled facts into unresolved tasks', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'GET') return new Response(null, { status: 404 });
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return init?.method === 'HEAD' ? new Response(null, { status: 200 }) : Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.indexFacts(item(), [
      {
        at: Date.parse('2026-09-19T15:01:00Z'),
        source: 'read',
        url: 'https://discord.com',
        title: 'Discord',
        text: 'Dinner at Seven Shores Cafe on Friday at 6.',
      },
    ]);

    const taskPut = fetchImpl.mock.calls.find(([url, init]) => String(url).includes('carat-test-tasks/_doc/') && init?.method === 'PUT');
    expect(taskPut).toBeDefined();
    const task = JSON.parse(String(taskPut![1]?.body));
    expect(task).toMatchObject({
      actionType: 'calendar_event',
      status: 'unresolved',
      groupKey: 'calendar-event-seven-shores-cafe-friday',
      timeValues: ['6'],
      placeValues: ['Seven Shores Cafe'],
    });
  });

  it('does not create generic follow-up tasks from non-executable notes', async () => {
    const writes: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'GET') return new Response(null, { status: 404 });
      if (init?.method === 'PUT') writes.push(String(url));
      return init?.method === 'HEAD' ? new Response(null, { status: 200 }) : Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.indexFacts(item(), [
      {
        at: Date.parse('2026-09-19T15:01:00Z'),
        source: 'read',
        url: 'https://discord.com',
        title: 'Discord',
        text: 'The user wrote down two things they might want to do later.',
      },
    ]);

    expect(writes.some((url) => url.includes('carat-test-facts/_doc/'))).toBe(true);
    expect(writes.some((url) => url.includes('carat-test-tasks/_doc/'))).toBe(false);
    // A distilled note lives in facts alone; it used to be copied into observations too.
    expect(writes.some((url) => url.includes('carat-test-observations/_doc/'))).toBe(false);
  });

  it('classifies side quests near an office as a Maps lookup, not a calendar event', async () => {
    const writes: Array<[string, Record<string, unknown>]> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'GET') return new Response(null, { status: 404 });
      if (init?.method === 'PUT' && init.body) writes.push([String(url), JSON.parse(String(init.body))]);
      return init?.method === 'HEAD' ? new Response(null, { status: 200 }) : Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.indexFacts(item(), [
      {
        at: Date.parse('2026-09-19T15:01:00Z'),
        source: 'read',
        url: 'https://discord.com',
        title: 'Discord',
        text: 'The user wants side quests near the Toronto Shopify office tomorrow.',
      },
    ]);

    const task = writes.find(([url]) => url.includes('carat-test-tasks/_doc/'))?.[1];
    expect(task).toMatchObject({ actionType: 'maps_lookup' });
  });

  it('writes a distilled note once, to facts, with no observation twin', async () => {
    const writes: Array<[string, Record<string, unknown>]> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'GET') return new Response(null, { status: 404 });
      if (init?.method === 'PUT' && init.body) writes.push([String(url), JSON.parse(String(init.body))]);
      return init?.method === 'HEAD' ? new Response(null, { status: 200 }) : Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.indexFacts(item(), [
      {
        at: Date.parse('2026-09-19T15:01:00Z'),
        source: 'read',
        url: 'https://discord.com',
        title: 'Discord',
        text: 'Side quests near the Toronto Shopify office tomorrow.',
      },
    ]);

    const fact = writes.find(([url]) => url.includes('carat-test-facts/_doc/'))?.[1];
    expect(fact).toMatchObject({
      sourceId: 'ctx-1',
      kind: 'fact',
      text: 'Side quests near the Toronto Shopify office tomorrow.',
    });
    expect(writes.filter(([url]) => url.includes('carat-test-facts/_doc/'))).toHaveLength(1);
    expect(writes.some(([url]) => url.includes('carat-test-observations/_doc/'))).toBe(false);
  });

  it('skips duplicate raw captures and distilled notes already present in Elastic', async () => {
    const writes: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (path.includes('_search')) {
        return Response.json({ hits: { hits: [{ _source: { id: 'existing', text: 'same content' } }] } });
      }
      if (init?.method === 'PUT') writes.push(path);
      return Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.indexObservation(item());
    await elastic.indexFacts(item(), [
      {
        at: Date.parse('2026-09-19T15:01:00Z'),
        source: 'read',
        url: 'https://discord.com',
        title: 'Discord',
        text: 'Dinner at Seven Shores Cafe on Friday at 6.',
      },
    ]);

    expect(writes.some((url) => url.includes('/_doc/'))).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('carat-test-tasks/_doc/'))).toBe(false);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('_search'))).toBe(true);
  });

  it('marks the task itself as a conflict when a new fact disagrees', async () => {
    const existing = {
      groupKey: 'calendar-event-seven-shores-cafe-friday',
      actionType: 'calendar_event',
      status: 'unresolved',
      text: 'Dinner at Seven Shores Cafe on Friday at 6.',
      texts: ['Dinner at Seven Shores Cafe on Friday at 6.'],
      hosts: ['discord.com'],
      sourceIds: ['old:0'],
      timeValues: ['6'],
      placeValues: ['Seven Shores Cafe'],
      firstSeenAt: '2026-09-19T15:00:00.000Z',
      lastSeenAt: '2026-09-19T15:00:00.000Z',
    };
    const writes: Array<[string, Record<string, unknown>]> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'GET') return Response.json({ _source: existing });
      if (init?.method === 'PUT' && init.body) writes.push([String(url), JSON.parse(String(init.body))]);
      return init?.method === 'HEAD' ? new Response(null, { status: 200 }) : Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.indexFacts(item(), [
      {
        at: Date.parse('2026-09-19T15:02:00Z'),
        source: 'read',
        url: 'https://mail.example.com',
        title: 'Mail',
        text: 'Dinner at Seven Shores Cafe on Friday at 7.',
      },
    ]);

    const task = writes.find(([url]) => url.includes('carat-test-tasks/_doc/'))?.[1];
    expect(task).toMatchObject({ status: 'conflict', conflictReason: 'time_mismatch', timeValues: ['6', '7'] });
    expect(writes.some(([url]) => url.includes('carat-test-cases'))).toBe(false);
  });

  it('merges a semantically similar task instead of creating a duplicate', async () => {
    const existing = {
      groupKey: 'calendar-event-seven-shores-cafe-friday',
      actionType: 'calendar_event',
      status: 'unresolved',
      text: 'Alex asked about dinner at Seven Shores Cafe on Friday at 6.',
      texts: ['Alex asked about dinner at Seven Shores Cafe on Friday at 6.'],
      hosts: ['discord.com'],
      sourceIds: ['old:0'],
      timeValues: ['6'],
      placeValues: ['Seven Shores Cafe'],
      firstSeenAt: '2026-09-19T15:00:00.000Z',
      lastSeenAt: '2026-09-19T15:00:00.000Z',
    };
    let similarSearchBody: Record<string, unknown> | undefined;
    const writes: Array<[string, Record<string, unknown>]> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (init?.method === 'GET') return new Response(null, { status: 404 });
      if (String(url).includes('carat-test-tasks/_search')) {
        similarSearchBody = JSON.parse(String(init?.body));
        return Response.json({ hits: { hits: [{ _source: existing }] } });
      }
      if (init?.method === 'PUT' && init.body) writes.push([String(url), JSON.parse(String(init.body))]);
      return Response.json({ acknowledged: true });
    });
    const elastic = createElasticMemory({
      settings: async () => settings({ elasticInferenceId: 'default' }),
      fetchImpl,
    });

    await elastic.indexFacts(item(), [
      {
        at: Date.parse('2026-09-19T15:03:00Z'),
        source: 'read',
        url: 'https://discord.com',
        title: 'Discord',
        text: 'Dinner with Alex Friday evening at 6.',
      },
    ]);

    const taskWrite = writes.find(([url]) => url.includes('carat-test-tasks/_doc/calendar-event-seven-shores-cafe-friday'))?.[1];
    expect(JSON.stringify(similarSearchBody)).toContain('"text_semantic"');
    expect(taskWrite).toMatchObject({
      groupKey: 'calendar-event-seven-shores-cafe-friday',
      actionType: 'calendar_event',
      sourceIds: ['old:0', 'ctx-1:0'],
    });
    expect(taskWrite?.texts).toContain('Dinner with Alex Friday evening at 6.');
  });

  it('adds ES|QL task summaries to retrieved evidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/_query')) {
        const query = JSON.parse(String(init?.body)).query;
        expect(query).toContain('actionType IN ("calendar_event")');
        expect(query).toContain('NOW() - 5 minutes');
        expect(query).toContain('STATS unresolved = COUNT(*) BY status, actionType');
        return Response.json({
          columns: [{ name: 'status' }, { name: 'actionType' }, { name: 'unresolved' }],
          values: [['conflict', 'calendar_event', 1], ['unresolved', 'calendar_event', 2]],
        });
      }
      return Response.json({ hits: { hits: [] } });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    const lines = await elastic.retrieve(req(), 1);

    expect(lines).toEqual(['[elasticsearch] ES|QL task summary: 1 conflict calendar_event task open in the last 5 minutes']);
  });

  it('creates the tasks index before running ES|QL on a fresh cluster', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (init?.method === 'HEAD' && path.endsWith('/carat-test-tasks')) return new Response(null, { status: 404 });
      if (init?.method === 'PUT' && path.endsWith('/carat-test-tasks')) return Response.json({ acknowledged: true });
      if (path.includes('/_query')) return Response.json({ columns: [], values: [] });
      return Response.json({ hits: { hits: [] } });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.retrieve(req(), 1);

    expect(fetchImpl).toHaveBeenCalledWith('https://elastic.example.com/carat-test-tasks', expect.objectContaining({ method: 'HEAD' }));
    expect(fetchImpl).toHaveBeenCalledWith('https://elastic.example.com/carat-test-tasks', expect.objectContaining({ method: 'PUT' }));
    const queryCall = fetchImpl.mock.calls.find(([url]) => String(url).includes('/_query'));
    expect(JSON.parse(String(queryCall?.[1]?.body)).query).toContain('FROM carat-test-tasks');
  });

  it('infers Maps capability from the accessibility tree and searches matching tasks', async () => {
    let searchBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('carat-test-tasks/_search')) searchBody = JSON.parse(String(init?.body));
      return Response.json({ hits: { hits: [] } });
    });
    const mapsReq: PageContext = {
      ...req(),
      url: 'https://www.google.com/maps',
      title: 'Google Maps',
      text: 'search:\n  >> FOCUSED [1] searchbox "Search Google Maps"',
      candidates: [{ n: 1, backendNodeId: 21, role: 'searchbox', name: 'Search Google Maps' }],
      focused: { role: 'searchbox', name: 'Search Google Maps' },
    };
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    const lines = await elastic.retrieve(mapsReq, 1);

    expect(JSON.stringify(searchBody)).toContain('"actionType":["maps_lookup"]');
    // The host decides alone, so a Maps page never pulls a calendar task.
    expect(JSON.stringify(searchBody)).not.toContain('calendar_event');
    expect(JSON.stringify(searchBody)).toContain('"lastSeenAt":{"gte":"now-5m"}');
    expect(lines).toEqual([]);
  });

  it('treats Discord direct messages as recent source context instead of an email task surface', async () => {
    let generalSearchBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.includes('carat-test-observations,carat-test-facts/_search')) {
        generalSearchBody = JSON.parse(String(init?.body));
        return Response.json({
          hits: {
            hits: [
              {
                _source: {
                  kind: 'page',
                  host: 'discord.com',
                  lastSeenAt: '2026-09-20T01:41:00Z',
                  text:
                    'nuth 9:30 PM hey did you want to meet somewhere next bloor yonge tmrw? like at 6ish? did you want me to find a restaurant? ok im going to find a restaurant near bloor younge nuth 9:41 PM okay im going to write down two things i want to do tmrw, like side quests maybe near the Toronto Shopify office?',
                },
              },
            ],
          },
        });
      }
      if (path.includes('carat-test-tasks')) throw new Error(`source page should not query task indices: ${path}`);
      return Response.json({ hits: { hits: [] } });
    });
    const discordReq: PageContext = {
      ...req(),
      url: 'https://discord.com/channels/@me/1475607861831929918',
      title: '(30) Discord | @Crazydodo',
      text: 'navigation "Private channels":\n  [1] button "Inbox"\nlist "Direct Messages":\nmain:\n  text: okay im going to write down two things i want to do tmrw, like side quests maybe near the Toronto Shopify office?\n  [2] textbox "Message @Crazydodo"',
      candidates: [{ n: 2, backendNodeId: 22, role: 'textbox', name: 'Message @Crazydodo' }],
      focused: { role: 'textbox', name: 'Message @Crazydodo' },
    };
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    const lines = await elastic.retrieve(discordReq, 7);

    expect(lines[0]).toContain('[elasticsearch] page from discord.com');
    expect(lines[0]).toContain('Toronto Shopify office');
    expect(lines[0]).not.toContain('find a restaurant near bloor');
    expect(JSON.stringify(generalSearchBody)).not.toContain('"actionType":["email"]');
    expect(JSON.stringify(generalSearchBody)).not.toContain('"must_not"');
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('carat-test-tasks'))).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/_query'))).toBe(false);
  });

  it('does not claim a calendar surface from page prose that merely says date and time', async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      paths.push(String(url));
      return Response.json({ hits: { hits: [] } });
    });
    const articleReq: PageContext = {
      ...req(),
      url: 'https://www.cbc.ca/news/festival',
      title: 'Festival returns',
      text: 'main:\n  heading(1) "Festival returns"\n  text: The event runs at a location downtown; check the date and time before you go.\n  [1] searchbox "Search CBC"',
      candidates: [{ n: 1, backendNodeId: 31, role: 'searchbox', name: 'Search CBC' }],
      focused: null,
    };
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.retrieve(articleReq, 4);

    // No destination host and no field named like one, so there is no task to pull.
    expect(paths.some((path) => path.includes('carat-test-tasks'))).toBe(false);
    expect(paths.some((path) => path.includes('/_query'))).toBe(false);
    expect(paths.some((path) => path.includes('carat-test-observations,carat-test-facts/_search'))).toBe(true);
  });

  it('runs the task and context queries side by side under one deadline', async () => {
    const started: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.includes('/_search') || path.includes('/_query')) {
        started.push(path);
        expect(init?.signal).toBeDefined();
      }
      return Response.json({ hits: { hits: [] } });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.retrieve(req(), 1);

    expect(started.filter((path) => path.includes('carat-test-tasks/_search'))).toHaveLength(1);
    expect(started.filter((path) => path.includes('carat-test-observations,carat-test-facts/_search'))).toHaveLength(1);
    expect(started.filter((path) => path.includes('/_query'))).toHaveLength(1);
  });

  it('renders the matched task as a single labelled line', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('carat-test-tasks/_search')) {
        return Response.json({
          hits: {
            hits: [
              {
                _source: {
                  groupKey: 'calendar-event-seven-shores-cafe-friday',
                  status: 'conflict',
                  actionType: 'calendar_event',
                  conflictReason: 'time_mismatch',
                  hosts: ['discord.com'],
                  text: 'Conflict needs review: Dinner at Seven Shores Cafe on Friday at 6. / Dinner at Seven Shores Cafe on Friday at 7.',
                  lastSeenAt: '2026-09-19T15:02:00.000Z',
                },
              },
            ],
          },
        });
      }
      return Response.json({ hits: { hits: [] } });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    const lines = await elastic.retrieve(req(), 1);

    expect(lines[0]).toBe(
      '[task] calendar_event from discord.com, conflict (time_mismatch): Conflict needs review: Dinner at Seven Shores Cafe on Friday at 6. / Dinner at Seven Shores Cafe on Friday at 7.',
    );
    expect(lines.filter((line) => line.startsWith('[task]'))).toHaveLength(1);
  });

  it('deletes stale task docs during the cleanup sweep', async () => {
    let cleanupBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('_delete_by_query')) cleanupBody = JSON.parse(String(init?.body));
      return Response.json({ deleted: 3 });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.sweepExpiredTasks();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://elastic.example.com/carat-test-tasks/_delete_by_query?ignore_unavailable=true&conflicts=proceed',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.stringify(cleanupBody)).toContain('"lastSeenAt":{"lte":"now-5m"}');
  });

  it('deletes matching unresolved tasks when an action is accepted or dismissed', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('_delete_by_query')) bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ acknowledged: true, deleted: 1 });
    });
    const elastic = createElasticMemory({ settings: async () => settings(), fetchImpl });

    await elastic.recordAction({
      tabId: 1,
      host: 'www.google.com',
      kind: 'open',
      label: 'Open "Seven Shores Cafe" in Maps',
      value: 'maps:Seven Shores Cafe',
      accepted: false,
    });

    const cleanup = bodies.at(-1);
    expect(JSON.stringify(cleanup)).toContain('"actionType":"maps_lookup"');
    expect(JSON.stringify(cleanup)).toContain('Seven Shores Cafe');
  });
});
