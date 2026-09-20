import type { ContextItem, NextActionKind, NextActionRequest, OutlineControl, Settings } from '@carat/shared';
import { hashText, normalizeWhitespace, resolveIntentValue, truncate } from '@carat/shared';
import type { Note } from './notes';

const MAX_EVIDENCE = 3;
const EVIDENCE_CHARS = 220;
const SEARCH_TIMEOUT_MS = 1800;
const DEFAULT_SEMANTIC_ENDPOINT = 'default';
/**
 * Two windows, because a task and a fact age differently. A task is hot
 * intent: what the user decided to do minutes ago, swept away at the same
 * five minutes it is retrieved over, so the lookback cannot outlive the TTL
 * and lie. Context is the long memory behind it.
 */
const TASK_WINDOW = 'now-5m';
const EVIDENCE_WINDOW = 'now-12h';
/** Write-time content dedupe only: observations and facts are never swept. */
const DUPLICATE_LOOKBACK = 'now-24h';
const INGEST_SCHEMA_VERSION = 1;
const DEBUG_PREVIEW_CHARS = 3200;

/** What the one line naming the thing this page can finish starts with. */
export const TASK_LINE_PREFIX = '[task]';

type ElasticSettings = Pick<Settings, 'elasticUrl' | 'elasticApiKey' | 'elasticIndexPrefix' | 'elasticInferenceId'>;

export interface ElasticMemory {
  indexObservation(item: ContextItem): Promise<void>;
  indexFacts(item: ContextItem, notes: Note[]): Promise<void>;
  retrieve(req: NextActionRequest, tabId?: number): Promise<string[]>;
  recordAction(action: { tabId?: number; host: string; kind: NextActionKind; name?: string; label: string; value?: string; accepted: boolean }): Promise<void>;
  sweepExpiredTasks(): Promise<void>;
}

export type ElasticDebugKind = 'pipeline' | 'mapping' | 'index' | 'search' | 'esql' | 'cleanup';

export interface ElasticDebugEvent {
  at: number;
  kind: ElasticDebugKind;
  tabId?: number;
  path: string;
  ok: boolean;
  status?: number;
  summary: string;
  request?: unknown;
  response?: unknown;
}

interface ElasticDeps {
  settings: () => Promise<ElasticSettings>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onDebug?: (event: ElasticDebugEvent) => void;
}

interface SearchHit {
  _index?: string;
  _score?: number;
  _source?: {
    groupKey?: string;
    tabId?: number;
    text?: string;
    texts?: string[];
    title?: string;
    host?: string;
    hosts?: string[];
    origin?: string;
    sourceIds?: string[];
    kind?: string;
    observationKind?: string;
    actionType?: string;
    status?: string;
    conflictReason?: string;
    conflictCount?: number;
    resolvedAt?: string;
    resolutionLabel?: string;
    timeValues?: string[];
    placeValues?: string[];
    firstSeenAt?: string;
    capturedAt?: string;
    at?: string;
    lastSeenAt?: string;
    confidence?: number;
  };
}

interface TaskDoc {
  groupKey: string;
  tabId?: number;
  actionType: string;
  status: 'unresolved' | 'conflict' | 'resolved';
  text: string;
  texts: string[];
  hosts: string[];
  sourceIds: string[];
  timeValues: string[];
  placeValues: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  conflictReason?: string;
  conflictCount?: number;
  resolvedAt?: string;
  resolutionLabel?: string;
}

interface RetrievalPlan {
  /** What the page can finish, plus `follow_up` when it merely takes typing. */
  capabilities: string[];
  /** The subset an indexed task can be matched against; never `follow_up`. */
  actionCapabilities: string[];
}

/**
 * Elasticsearch is optional and best-effort: a bad key, a sleeping deployment
 * or a mapping mismatch should never stop the chip path. The first successful
 * write creates the three demo indices automatically.
 */
export function createElasticMemory(deps: ElasticDeps): ElasticMemory {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const ensured = new Set<string>();
  const pipelines = new Map<string, boolean>();

  function debug(event: Omit<ElasticDebugEvent, 'at'>): void {
    try {
      deps.onDebug?.({
        ...event,
        at: now(),
        request: previewPayload(event.request),
        response: previewPayload(event.response),
      });
    } catch {
      // Debugging must never affect the Elastic context path.
    }
  }

  async function cfg(): Promise<ElasticSettings | null> {
    const s = await deps.settings();
    if (!s.elasticUrl || !s.elasticApiKey) return null;
    return {
      elasticUrl: s.elasticUrl.replace(/\/+$/, ''),
      elasticApiKey: s.elasticApiKey,
      elasticIndexPrefix: indexPrefix(s.elasticIndexPrefix),
      elasticInferenceId: s.elasticInferenceId.trim(),
    };
  }

  async function send(s: ElasticSettings, path: string, init: RequestInit = {}): Promise<Response> {
    return fetchImpl(`${s.elasticUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `ApiKey ${s.elasticApiKey}`,
        ...(init.headers ?? {}),
      },
    });
  }

  async function ensure(s: ElasticSettings, kind: IndexKind): Promise<string> {
    const index = indexName(s, kind);
    const key = `${index}:${s.elasticInferenceId || '-'}`;
    if (ensured.has(key)) return index;
    const path = `/${encodeURIComponent(index)}`;
    const exists = await send(s, path, { method: 'HEAD' });
    if (exists.status === 404) {
      const request = indexDefinition(kind, s.elasticInferenceId);
      const created = await send(s, path, {
        method: 'PUT',
        body: JSON.stringify(request),
      });
      const response = await responsePreview(created);
      debug({
        kind: 'mapping',
        path,
        ok: created.ok,
        status: created.status,
        summary: `${created.ok ? 'created' : 'failed to create'} ${index} mapping`,
        request,
        response,
      });
      if (!created.ok) throw new Error(`elastic create ${index} failed`);
    } else if (!exists.ok) {
      debug({
        kind: 'mapping',
        path,
        ok: false,
        status: exists.status,
        summary: `failed to check ${index} mapping`,
        response: { ok: exists.ok, status: exists.status, statusText: exists.statusText },
      });
      throw new Error(`elastic check ${index} failed`);
    } else {
      debug({
        kind: 'mapping',
        path,
        ok: true,
        status: exists.status,
        summary: `${index} mapping already exists`,
        response: { ok: exists.ok, status: exists.status, statusText: exists.statusText },
      });
    }
    ensured.add(key);
    return index;
  }

  async function ensurePipeline(s: ElasticSettings): Promise<string | undefined> {
    const id = pipelineName(s);
    const cached = pipelines.get(id);
    if (cached !== undefined) return cached ? id : undefined;
    const path = `/_ingest/pipeline/${encodeURIComponent(id)}`;
    const request = pipelineDefinition(s);
    const res = await send(s, `/_ingest/pipeline/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(request),
    }).catch(() => undefined);
    const ok = res?.ok === true;
    debug({
      kind: 'pipeline',
      path,
      ok,
      status: res?.status,
      summary: ok ? `created/updated ingest pipeline ${id}` : `failed to create ingest pipeline ${id}`,
      request,
      response: res ? { ok: res.ok, status: res.status, statusText: res.statusText } : { error: 'request failed' },
    });
    pipelines.set(id, ok);
    return ok ? id : undefined;
  }

  async function indexDoc(s: ElasticSettings, kind: IndexKind, id: string, doc: Record<string, unknown>, tabId?: number): Promise<void> {
    const index = await ensure(s, kind);
    const pipeline = await ensurePipeline(s);
    const suffix = pipeline ? `?pipeline=${encodeURIComponent(pipeline)}` : '';
    const path = `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}${suffix}`;
    const res = await send(s, path, {
      method: 'PUT',
      body: JSON.stringify(doc),
    });
    const response = await responsePreview(res);
    debug({
      kind: 'index',
      tabId,
      path,
      ok: res.ok,
      status: res.status,
      summary: `${res.ok ? 'indexed' : 'failed to index'} ${kind} document ${id}`,
      request: doc,
      response,
    });
    if (!res.ok) throw new Error(`elastic index ${index} failed`);
  }

  async function duplicateExists(
    s: ElasticSettings,
    kind: IndexKind,
    text: string,
    filters: Array<Record<string, unknown>>,
    tabId?: number,
  ): Promise<boolean> {
    const contentKey = keyForContent(text);
    const index = await ensure(s, kind);
    const request = {
      size: 1,
      _source: ['id', 'sourceId', 'kind', 'host', 'text', 'at', 'capturedAt', 'lastSeenAt'],
      query: {
        bool: {
          filter: [
            { term: { contentKey } },
            {
              bool: {
                should: [
                  { range: { at: { gte: DUPLICATE_LOOKBACK } } },
                  { range: { capturedAt: { gte: DUPLICATE_LOOKBACK } } },
                  { range: { lastSeenAt: { gte: DUPLICATE_LOOKBACK } } },
                  { range: { indexedAt: { gte: DUPLICATE_LOOKBACK } } },
                ],
                minimum_should_match: 1,
              },
            },
            ...filters,
          ],
        },
      },
    };
    const path = `/${encodeURIComponent(index)}/_search?ignore_unavailable=true`;
    try {
      const res = await send(s, path, { method: 'POST', body: JSON.stringify(request) });
      const json = await responsePreview(res) as { hits?: { hits?: SearchHit[] } };
      const found = (json.hits?.hits?.length ?? 0) > 0;
      debug({
        kind: 'search',
        tabId,
        path,
        ok: res.ok,
        status: res.status,
        summary: found ? `duplicate ${kind} content already indexed` : `unique ${kind} content`,
        request,
        response: json,
      });
      return res.ok && found;
    } catch (err) {
      debug({
        kind: 'search',
        tabId,
        path,
        ok: false,
        summary: `duplicate ${kind} check failed`,
        request,
        response: errorMessage(err),
      });
      return false;
    }
  }

  /**
   * One retrieval, one deadline. The task query and the evidence query are
   * different questions over different time windows, so they run side by side
   * and share a single abort: a sleeping deployment costs the chip one
   * timeout, not one per round-trip. The ES|QL rollup only runs when the page
   * can actually complete something, because a count of tasks the page cannot
   * touch is noise in the prompt.
   */
  async function search(s: ElasticSettings, req: NextActionRequest, tabId?: number): Promise<string[]> {
    const plan = retrievalPlan(req);
    const query = searchText(req, plan);
    if (!query) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const [task, evidence, summary] = await Promise.all([
        plan.actionCapabilities.length ? topTask(s, plan, query, tabId, controller.signal) : Promise.resolve([]),
        evidenceHits(s, query, tabId, controller.signal),
        plan.actionCapabilities.length ? taskSummary(s, plan, tabId, controller.signal) : Promise.resolve([]),
      ]);
      const taskText = new Set(task.map((line) => keyText(line)));
      return [...task, ...summary, ...evidence.filter((line) => !taskText.has(keyText(line)))];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The one thing this page can finish. Ranked by relevance to the page rather
   * than by recency: on Maps the newest task in the cluster is often a
   * calendar one, and sorting by `lastSeenAt` would hand that over instead.
   */
  async function topTask(s: ElasticSettings, plan: RetrievalPlan, query: string, tabId: number | undefined, signal: AbortSignal): Promise<string[]> {
    const index = await ensure(s, 'tasks');
    const filter: Array<Record<string, unknown>> = [
      { terms: { status: ['unresolved', 'conflict'] } },
      { terms: { actionType: plan.actionCapabilities } },
      { range: { lastSeenAt: { gte: TASK_WINDOW } } },
    ];
    if (tabId !== undefined) filter.push({ bool: { must_not: { term: { tabId } } } });
    // A conflict outranks a clean task of the same type: the disagreement is
    // the thing worth surfacing, and the prompt tells the model not to fill it.
    const conflictBoost = { constant_score: { filter: { term: { status: 'conflict' } }, boost: 6 } };
    const lexical = {
      bool: {
        should: [
          { multi_match: { query, fields: ['text^3', 'texts^2', 'hosts'], type: 'best_fields' } },
          { match_phrase: { text: { query, boost: 2 } } },
          conflictBoost,
        ],
        filter,
        minimum_should_match: 1,
      },
    };
    const request: Record<string, unknown> = {
      size: 1,
      _source: ['text', 'hosts', 'host', 'origin', 'status', 'actionType', 'conflictReason', 'sourceIds', 'lastSeenAt'],
      ...(semanticEnabled(s)
        ? {
            retriever: {
              rrf: {
                retrievers: [
                  { standard: { query: lexical } },
                  { standard: { query: { bool: { must: [{ match: { text_semantic: query } }], should: [conflictBoost], filter } } } },
                ],
                rank_window_size: 10,
                rank_constant: 20,
              },
            },
          }
        : { query: lexical }),
    };
    const path = `/${encodeURIComponent(index)}/_search?ignore_unavailable=true`;
    try {
      const res = await send(s, path, { method: 'POST', body: JSON.stringify(request), signal });
      const json = await responsePreview(res) as { hits?: { hits?: SearchHit[] } };
      const hit = json.hits?.hits?.[0];
      const line = res.ok && hit ? renderTask(hit) : '';
      debug({
        kind: 'search',
        tabId,
        path,
        ok: res.ok,
        status: res.status,
        summary: `DOM capability: ${plan.capabilities.join(', ') || 'none'}; ${line ? 'matched 1 actionable task' : 'no actionable task in the last 5 minutes'}`,
        request,
        response: json,
      });
      return line ? [line] : [];
    } catch (err) {
      debug({
        kind: 'search',
        tabId,
        path,
        ok: false,
        summary: `DOM capability: ${plan.capabilities.join(', ') || 'none'}; task search failed`,
        request,
        response: errorMessage(err),
      });
      return [];
    }
  }

  /** The context behind the task: raw captures and distilled facts, hybrid-ranked. */
  async function evidenceHits(s: ElasticSettings, query: string, tabId: number | undefined, signal: AbortSignal): Promise<string[]> {
    const indices = (['observations', 'facts'] as const).map((k) => indexName(s, k)).join(',');
    const body = searchBody(s, query);
    const path = `/${indices}/_search?ignore_unavailable=true`;
    try {
      const res = await send(s, path, { method: 'POST', body: JSON.stringify(body), signal });
      const json = await responsePreview(res) as { hits?: { hits?: SearchHit[] } };
      debug({
        kind: 'search',
        tabId,
        path,
        ok: res.ok,
        status: res.status,
        summary: res.ok ? `retrieved ${json.hits?.hits?.length ?? 0} Elastic context item(s)` : 'Elastic context search failed',
        request: body,
        response: json,
      });
      if (!res.ok) return [];
      return (json.hits?.hits ?? []).slice(0, MAX_EVIDENCE).map(renderHit).filter(Boolean);
    } catch (err) {
      debug({
        kind: 'search',
        tabId,
        path,
        ok: false,
        summary: 'Elastic context search request failed',
        request: body,
        response: errorMessage(err),
      });
      return [];
    }
  }


  async function getTask(s: ElasticSettings, groupKey: string): Promise<TaskDoc | null> {
    const index = await ensure(s, 'tasks');
    const res = await send(s, `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(groupKey)}`, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`elastic get task ${groupKey} failed`);
    const json = (await res.json()) as { _source?: TaskDoc };
    return json._source ?? null;
  }

  async function upsertTask(s: ElasticSettings, item: ContextItem, note: Note, ordinal: number): Promise<void> {
    const parsed = parseTask(note.text);
    if (!isActionableTaskType(parsed.actionType)) return;
    const at = new Date(note.at).toISOString();
    const sourceId = `${item.id}:${ordinal}`;
    const text = normalizeWhitespace(note.text);
    const exact = await getTask(s, parsed.groupKey).catch(() => null);
    const similar = exact ? null : await findSimilarTask(s, parsed, text, note.tabId).catch(() => null);
    const existing = exact ?? similar;
    const groupKey = existing?.groupKey ?? parsed.groupKey;
    const hosts = unique([...(existing?.hosts ?? []), hostOf(note.origin)]);
    const sourceIds = unique([...(existing?.sourceIds ?? []), sourceId]);
    const texts = unique([...(existing?.texts ?? []), text]).slice(-8);
    const timeValues = unique([...(existing?.timeValues ?? []), ...parsed.timeValues]);
    const placeValues = unique([...(existing?.placeValues ?? []), ...parsed.placeValues]);
    const conflictReason = conflictFor(existing, parsed, text);
    const doc: TaskDoc = {
      groupKey,
      tabId: note.tabId,
      actionType: parsed.actionType,
      status: conflictReason ? 'conflict' : (existing?.status ?? 'unresolved'),
      text: conflictReason ? `Conflict needs review: ${texts.join(' / ')}` : text,
      texts,
      hosts,
      sourceIds,
      timeValues,
      placeValues,
      firstSeenAt: existing?.firstSeenAt ?? at,
      lastSeenAt: at,
      ...(conflictReason ? { conflictReason, conflictCount: (existing?.conflictCount ?? 0) + 1 } : {}),
    };
    await indexDoc(s, 'tasks', groupKey, { ...doc, ...(semanticEnabled(s) ? { text_semantic: doc.text } : {}) }, note.tabId);
  }

  async function findSimilarTask(s: ElasticSettings, parsed: ParsedTask, text: string, tabId?: number): Promise<TaskDoc | null> {
    const index = await ensure(s, 'tasks');
    const filter: Array<Record<string, unknown>> = [
      { terms: { status: ['unresolved', 'conflict'] } },
      { term: { actionType: parsed.actionType } },
      { range: { lastSeenAt: { gte: TASK_WINDOW } } },
    ];
    const lexical = {
      bool: {
        should: [
          { match: { text: { query: text, boost: 3 } } },
          { match_phrase: { text: { query: text, boost: 4 } } },
          ...(parsed.placeValues.length ? [{ terms: { placeValues: parsed.placeValues } }] : []),
        ],
        filter,
        minimum_should_match: 1,
      },
    };
    const request: Record<string, unknown> = {
      size: 1,
      _source: ['groupKey', 'tabId', 'actionType', 'status', 'text', 'texts', 'hosts', 'sourceIds', 'timeValues', 'placeValues', 'firstSeenAt', 'lastSeenAt', 'conflictReason', 'conflictCount'],
      ...(semanticEnabled(s)
        ? {
            retriever: {
              rrf: {
                retrievers: [
                  { standard: { query: lexical } },
                  { standard: { query: { bool: { must: [{ match: { text_semantic: text } }], filter } } } },
                ],
                rank_window_size: 10,
                rank_constant: 20,
              },
            },
          }
        : { query: lexical }),
    };
    const path = `/${encodeURIComponent(index)}/_search?ignore_unavailable=true`;
    try {
      const res = await send(s, path, { method: 'POST', body: JSON.stringify(request) });
      const json = await responsePreview(res) as { hits?: { hits?: SearchHit[] } };
      const hit = json.hits?.hits?.[0];
      const candidate = hit?._source ? taskFromHit(hit._source) : null;
      const reusable = candidate && taskLooksReusable(candidate, parsed) ? candidate : null;
      debug({
        kind: 'search',
        tabId,
        path,
        ok: res.ok,
        status: res.status,
        summary: reusable ? `merged similar task ${reusable.groupKey}` : 'no reusable similar task found',
        request,
        response: json,
      });
      if (!res.ok) return null;
      return reusable;
    } catch (err) {
      debug({
        kind: 'search',
        tabId,
        path,
        ok: false,
        summary: 'similar task search failed',
        request,
        response: errorMessage(err),
      });
      return null;
    }
  }

  /** The Elastic-side rollup: one ES|QL line counting what is still open. */
  async function taskSummary(s: ElasticSettings, plan: RetrievalPlan, tabId: number | undefined, signal: AbortSignal): Promise<string[]> {
    const actionFilter = plan.actionCapabilities.length ? ` AND actionType IN (${plan.actionCapabilities.map(esqlString).join(', ')})` : '';
    let request: { query: string } | undefined;
    try {
      const index = await ensure(s, 'tasks');
      request = {
        query: `FROM ${index} METADATA _score | WHERE lastSeenAt >= NOW() - 5 minutes AND status IN ("unresolved", "conflict")${actionFilter} | STATS unresolved = COUNT(*) BY status, actionType | SORT status`,
      };
      const res = await send(s, '/_query?format=json', {
        method: 'POST',
        body: JSON.stringify(request),
        signal,
      });
      const json = await responsePreview(res) as { columns?: Array<{ name?: string }>; values?: unknown[][] };
      debug({
        kind: 'esql',
        tabId,
        path: '/_query?format=json',
        ok: res.ok,
        status: res.status,
        summary: res.ok ? `ES|QL returned ${json.values?.length ?? 0} row(s)` : 'ES|QL task summary failed',
        request,
        response: json,
      });
      if (!res.ok) return [];
      const names = (json.columns ?? []).map((c) => c.name ?? '');
      const statusIndex = Math.max(0, names.indexOf('status'));
      const actionIndex = names.indexOf('actionType');
      const countIndex = Math.max(0, names.indexOf('unresolved'));
      const lines = (json.values ?? [])
        .map((row) => {
          const status = String(row[statusIndex] ?? '');
          const action = actionIndex >= 0 ? String(row[actionIndex] ?? '') : '';
          const count = Number(row[countIndex] ?? 0);
          const actionText = action ? ` ${action}` : '';
          return status && count ? `[elasticsearch] ES|QL task summary: ${count} ${status}${actionText} task${count === 1 ? '' : 's'} open in the last 5 minutes` : '';
        })
        .filter(Boolean);
      return lines.slice(0, 1);
    } catch (err) {
      debug({
        kind: 'esql',
        tabId,
        path: '/_query?format=json',
        ok: false,
        summary: 'ES|QL task summary request failed',
        request: request ?? { index: indexName(s, 'tasks') },
        response: errorMessage(err),
      });
      return [];
    }
  }

  async function deleteByQuery(s: ElasticSettings, indices: string, request: Record<string, unknown>, summary: string, tabId?: number): Promise<void> {
    const path = `/${indices}/_delete_by_query?ignore_unavailable=true&conflicts=proceed`;
    try {
      const res = await send(s, path, { method: 'POST', body: JSON.stringify(request) });
      const json = await responsePreview(res);
      debug({
        kind: 'cleanup',
        tabId,
        path,
        ok: res.ok,
        status: res.status,
        summary,
        request,
        response: json,
      });
    } catch (err) {
      debug({
        kind: 'cleanup',
        tabId,
        path,
        ok: false,
        summary: `${summary} failed`,
        request,
        response: errorMessage(err),
      });
    }
  }

  async function deleteExpiredTasks(s: ElasticSettings): Promise<void> {
    const indices = indexName(s, 'tasks');
    const request = {
      query: {
        bool: {
          filter: [{ range: { lastSeenAt: { lte: TASK_WINDOW } } }],
        },
      },
    };
    await deleteByQuery(s, indices, request, 'deleted task docs older than 5 minutes');
  }

  async function deleteMatchedTasks(s: ElasticSettings, action: { tabId?: number; kind: NextActionKind; name?: string; label: string; value?: string; accepted: boolean }): Promise<void> {
    const actionType = actionTypeForCompletedAction(action);
    if (!actionType) return;
    const terms = completedActionTerms(action);
    if (terms.length === 0) return;
    const indices = indexName(s, 'tasks');
    const request = {
      query: {
        bool: {
          filter: [
            { terms: { status: ['unresolved', 'conflict'] } },
            { term: { actionType } },
            { range: { lastSeenAt: { gte: TASK_WINDOW } } },
          ],
          should: terms.flatMap((term) => [
            { match_phrase: { text: term } },
            { term: { placeValues: term } },
            { term: { timeValues: term.toLowerCase().replace(/\s+/g, '') } },
          ]),
          minimum_should_match: 1,
        },
      },
    };
    await deleteByQuery(s, indices, request, `deleted ${action.accepted ? 'accepted' : 'dismissed'} ${actionType} task(s)`, action.tabId);
  }

  async function duplicateDistilledNote(s: ElasticSettings, note: Note, text: string): Promise<boolean> {
    return duplicateExists(
      s,
      'facts',
      text,
      [
        { term: { kind: 'fact' } },
        { term: { host: hostOf(note.origin) } },
      ],
      note.tabId,
    );
  }

  return {
    async indexObservation(item) {
      const s = await cfg();
      if (!s) return;
      const text = normalizeWhitespace(item.text);
      if (!text) return;
      const duplicate = await duplicateExists(
        s,
        'observations',
        text,
        [{ term: { host: hostOf(item.origin) } }],
        item.tabId,
      ).catch(() => false);
      if (duplicate) return;
      const doc: Record<string, unknown> = {
        id: item.id,
        tabId: item.tabId,
        origin: item.origin,
        host: hostOf(item.origin),
        path: item.path,
        title: item.title,
        kind: item.kind,
        observationKind: item.kind,
        contentKey: keyForContent(text),
        text,
        capturedAt: new Date(item.capturedAt).toISOString(),
        lastSeenAt: new Date(item.lastSeenAt).toISOString(),
        indexedAt: new Date(now()).toISOString(),
        hash: item.hash,
      };
      if (semanticEnabled(s)) doc.text_semantic = text;
      await indexDoc(s, 'observations', item.id, doc, item.tabId).catch(() => undefined);
    },
    async indexFacts(item, notes) {
      const s = await cfg();
      if (!s || notes.length === 0) return;
      await Promise.all(
        notes.map((note, i) => {
          const text = normalizeWhitespace(note.text);
          if (!text) return Promise.resolve();
          const doc: Record<string, unknown> = {
            id: `${item.id}:${i}`,
            sourceId: item.id,
            tabId: note.tabId,
            origin: note.origin,
            host: hostOf(note.origin),
            title: note.title,
            kind: 'fact',
            contentKey: keyForContent(text),
            text,
            at: new Date(note.at).toISOString(),
            indexedAt: new Date(now()).toISOString(),
          };
          if (semanticEnabled(s)) doc.text_semantic = text;
          return (async () => {
            if (await duplicateDistilledNote(s, note, text).catch(() => false)) return;
            await Promise.all([
              indexDoc(s, 'facts', `${item.id}:${i}`, doc, note.tabId),
              upsertTask(s, item, note, i),
            ]);
          })().catch(() => undefined);
        }),
      );
    },
    async retrieve(req, tabId) {
      const s = await cfg();
      if (!s) return [];
      return search(s, req, tabId);
    },
    async recordAction(action) {
      const s = await cfg();
      if (!s) return;
      const at = now();
      const text = `${action.accepted ? 'accepted' : 'dismissed'} ${action.kind}: ${action.label}`;
      const doc = {
        tabId: action.tabId,
        host: action.host,
        kind: action.kind,
        label: action.label,
        value: action.value ?? '',
        accepted: action.accepted,
        text,
        at: new Date(at).toISOString(),
      };
      await indexDoc(s, 'actions', `${at}:${Math.random().toString(36).slice(2)}`, doc, action.tabId).catch(() => undefined);
      await deleteMatchedTasks(s, action).catch(() => undefined);
    },
    async sweepExpiredTasks() {
      const s = await cfg();
      if (!s) return;
      await deleteExpiredTasks(s).catch(() => undefined);
    },
  };
}

async function responsePreview(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return { ok: res.ok, status: res.status, statusText: res.statusText };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function previewPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return truncate(value, DEBUG_PREVIEW_CHARS);
  try {
    const json = JSON.stringify(value);
    if (json.length <= DEBUG_PREVIEW_CHARS) return value;
    return {
      truncated: true,
      chars: json.length,
      preview: `${json.slice(0, DEBUG_PREVIEW_CHARS)}...`,
    };
  } catch {
    return String(value);
  }
}

function errorMessage(err: unknown): Record<string, string> {
  return { error: err instanceof Error ? err.message : String(err) };
}

type IndexKind = 'observations' | 'facts' | 'actions' | 'tasks';

function indexName(s: ElasticSettings, kind: IndexKind): string {
  return `${indexPrefix(s.elasticIndexPrefix)}-${kind}`;
}

function pipelineName(s: ElasticSettings): string {
  return `${indexPrefix(s.elasticIndexPrefix)}-carat-ingest`;
}

function semanticEnabled(s: ElasticSettings): boolean {
  return s.elasticInferenceId !== '';
}

function keyForContent(text: string): string {
  return String(hashText(text));
}

function indexPrefix(v: string): string {
  return (
    v
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'carat'
  );
}

function indexDefinition(_kind: IndexKind, inferenceId: string): Record<string, unknown> {
  const textFields: Record<string, unknown> = {
    text: { type: 'text' },
  };
  if (inferenceId) textFields.text_semantic = semanticField(inferenceId);
  return {
    mappings: {
      properties: {
        ...textFields,
        id: { type: 'keyword' },
        sourceId: { type: 'keyword' },
        tabId: { type: 'integer' },
        origin: { type: 'keyword' },
        origin_normalized: { type: 'keyword' },
        host: { type: 'keyword' },
        host_normalized: { type: 'keyword' },
        path: { type: 'keyword' },
        title: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
        kind: { type: 'keyword' },
        observationKind: { type: 'keyword' },
        contentKey: { type: 'keyword' },
        groupKey: { type: 'keyword' },
        actionType: { type: 'keyword' },
        status: { type: 'keyword' },
        conflictReason: { type: 'text' },
        conflictCount: { type: 'integer' },
        texts: { type: 'text' },
        hosts: { type: 'keyword' },
        sourceIds: { type: 'keyword' },
        timeValues: { type: 'keyword' },
        placeValues: { type: 'keyword' },
        label: { type: 'text' },
        value: { type: 'text' },
        accepted: { type: 'boolean' },
        hash: { type: 'long' },
        confidence: { type: 'float' },
        capturedAt: { type: 'date' },
        lastSeenAt: { type: 'date' },
        firstSeenAt: { type: 'date' },
        received_at: { type: 'date' },
        at: { type: 'date' },
        indexedAt: { type: 'date' },
        event: {
          properties: {
            category: { type: 'keyword' },
            dataset: { type: 'keyword' },
            kind: { type: 'keyword' },
            module: { type: 'keyword' },
          },
        },
        carat: {
          properties: {
            ingest_pipeline: { type: 'keyword' },
            schema_version: { type: 'integer' },
            semantic_enabled: { type: 'boolean' },
          },
        },
      },
    },
  };
}

function pipelineDefinition(s: ElasticSettings): Record<string, unknown> {
  return {
    description: 'Carat ingest normalization: timestamps, normalized host fields, ECS-ish event metadata, and lightweight sensitive-number redaction.',
    processors: [
      { set: { field: 'received_at', value: '{{{_ingest.timestamp}}}' } },
      { set: { field: 'event.module', value: 'carat' } },
      { set: { field: 'event.dataset', value: `${indexPrefix(s.elasticIndexPrefix)}.context` } },
      { set: { field: 'event.kind', value: 'event' } },
      { set: { field: 'carat.ingest_pipeline', value: pipelineName(s) } },
      { set: { field: 'carat.schema_version', value: INGEST_SCHEMA_VERSION } },
      { set: { field: 'carat.semantic_enabled', value: semanticEnabled(s) } },
      { lowercase: { field: 'host', target_field: 'host_normalized', ignore_missing: true } },
      { lowercase: { field: 'origin', target_field: 'origin_normalized', ignore_missing: true } },
      { lowercase: { field: 'actionType', target_field: 'event.category', ignore_missing: true } },
      redactionProcessor('text'),
      redactionProcessor('text_semantic'),
      redactionProcessor('label'),
      redactionProcessor('value'),
    ],
  };
}

function redactionProcessor(field: string): Record<string, unknown> {
  return {
    gsub: {
      field,
      pattern: '\\b(?:\\d[ -]*?){13,19}\\b',
      replacement: '[redacted-number]',
      ignore_missing: true,
    },
  };
}

function semanticField(inferenceId: string): Record<string, unknown> {
  if (inferenceId === DEFAULT_SEMANTIC_ENDPOINT) return { type: 'semantic_text' };
  return { type: 'semantic_text', inference_id: inferenceId };
}

/**
 * The context query: BM25 alone, or RRF over BM25 and `semantic_text` when an
 * inference endpoint is configured. Tasks are not searched here — they have
 * their own window and their own line, and the `at`/`capturedAt` recency
 * filter below would never have matched a task document anyway.
 */
function searchBody(s: ElasticSettings, query: string): Record<string, unknown> {
  const filter: Array<Record<string, unknown>> = [
    {
      bool: {
        should: [{ range: { at: { gte: EVIDENCE_WINDOW } } }, { range: { capturedAt: { gte: EVIDENCE_WINDOW } } }],
        minimum_should_match: 1,
      },
    },
  ];
  const lexical = {
    bool: {
      should: [
        { multi_match: { query, fields: ['text^3', 'title^2', 'host', 'path'], type: 'best_fields' } },
        { match_phrase: { text: { query, boost: 2 } } },
      ],
      filter,
      minimum_should_match: 1,
    },
  };
  const base = {
    size: MAX_EVIDENCE,
    _source: ['text', 'title', 'host', 'origin', 'kind', 'observationKind', 'capturedAt', 'at', 'lastSeenAt'],
  };
  if (!semanticEnabled(s)) return { ...base, query: lexical };
  return {
    ...base,
    retriever: {
      rrf: {
        retrievers: [
          { standard: { query: lexical } },
          { standard: { query: { bool: { must: [{ match: { text_semantic: query } }], filter } } } },
        ],
        rank_window_size: 30,
        rank_constant: 20,
      },
    },
  };
}

/**
 * What this page can actually finish, in two tiers. The host decides when it
 * is one of Carat's destinations, and then it decides alone: on Maps the only
 * task worth pulling is a Maps task. Otherwise the capability has to be
 * spelled out by a control the model could type into — matching page prose
 * meant a news article with a date in it claimed to be a calendar, and the
 * task filter then pointed at the wrong bucket.
 */
function retrievalPlan(req: NextActionRequest): RetrievalPlan {
  const where = `${req.page.host}${req.page.path}`.toLowerCase();
  const destination = destinationCapability(where);
  const actionCaps = destination ? [destination] : unique(req.controls.flatMap(controlCapability));
  const capabilities = [...actionCaps];
  if (req.controls.some((c) => ['textbox', 'searchbox', 'combobox', 'select'].includes(c.role))) capabilities.push('follow_up');
  return { capabilities: unique(capabilities), actionCapabilities: actionCaps };
}

/** One of Carat's own destinations, by host and path only. */
function destinationCapability(where: string): string | null {
  if (/^calendar\.google\.com|^outlook\.live\.com\/calendar|^outlook\.office\.com\/calendar/.test(where)) return 'calendar_event';
  if (/^maps\.google\.[^/]+|^(?:www\.)?google\.[^/]+\/maps/.test(where)) return 'maps_lookup';
  if (/^mail\.google\.com|^outlook\.live\.com\/mail|^outlook\.office\.com\/mail/.test(where)) return 'email';
  return null;
}

/** A field named like the thing the capability would fill. Names only, never page text. */
function controlCapability(control: OutlineControl): string[] {
  if (!['textbox', 'searchbox', 'combobox', 'select'].includes(control.role)) return [];
  const name = normalizeWhitespace(control.name).toLowerCase();
  if (!name) return [];
  if (/^(to|cc|bcc|recipients?|subject)$|\bemail address\b|\brecipients?\b|\bsubject line\b/.test(name)) return ['email'];
  if (/\b(search (google )?maps|address|destination|directions|where to)\b/.test(name)) return ['maps_lookup'];
  if (/\b(event (title|name)|location|venue|start (date|time)|end (date|time)|guests?|attendees?)\b/.test(name)) return ['calendar_event'];
  return [];
}

function searchText(req: NextActionRequest, plan: RetrievalPlan): string {
  return normalizeWhitespace(
    [
      plan.capabilities.join(' '),
      req.page.title,
      req.page.host,
      req.focused ? req.controls.find((c) => c.n === req.focused)?.name : '',
      req.history.slice(-4).join(' '),
      req.outline.slice(0, 1200),
    ].join(' '),
  );
}

function esqlString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Supporting context. One shape, so the model reads them as one class of line. */
function renderHit(hit: SearchHit): string {
  const source = hit._source;
  if (!source?.text) return '';
  const host = source.host || hostOf(source.origin ?? '');
  const kind = source.kind ? `${source.kind} ` : '';
  const when = source.at || source.capturedAt || source.lastSeenAt ? `, ${source.at || source.capturedAt || source.lastSeenAt}` : '';
  return `[elasticsearch] ${kind}from ${host}${when}: ${evidenceSnippet(source.text, host)}`;
}

/**
 * The task line. It names the action type, so the model can see whether this
 * page is where it gets done, and says out loud when the sources disagree.
 */
function renderTask(hit: SearchHit): string {
  const source = hit._source;
  if (!source?.text || !source.status || !source.actionType) return '';
  const host = source.host || source.hosts?.[0] || hostOf(source.origin ?? '');
  const conflict = source.status === 'conflict' ? `, conflict (${source.conflictReason ?? 'sources disagree'})` : '';
  return `${TASK_LINE_PREFIX} ${source.actionType} from ${host}${conflict}: ${truncate(normalizeWhitespace(source.text), EVIDENCE_CHARS)}`;
}

function evidenceSnippet(text: string, host: string): string {
  const clean = normalizeWhitespace(text);
  // A chat page is a wall of history; the newest message is the part worth carrying.
  const latest = /discord\.com|slack\.com|teams\.microsoft\.com/i.test(host) ? latestChatSnippet(clean) : '';
  const picked = latest || clean;
  return picked.length > EVIDENCE_CHARS ? truncate(picked, EVIDENCE_CHARS) : picked;
}

function latestChatSnippet(text: string): string {
  const stamps = [...text.matchAll(/\b(?:[A-Za-z][\w'.-]{1,32}\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)\b/gi)];
  if (stamps.length === 0) return '';
  let best = stamps[0]!;
  let bestMinutes = -1;
  for (const stamp of stamps) {
    const hour = Number(stamp[1]);
    const minute = Number(stamp[2]);
    const marker = stamp[3]!.toLowerCase();
    if (hour < 1 || hour > 12 || minute > 59) continue;
    const minutes = ((hour % 12) + (marker === 'pm' ? 12 : 0)) * 60 + minute;
    if (minutes >= bestMinutes) {
      best = stamp;
      bestMinutes = minutes;
    }
  }
  const index = best.index ?? 0;
  const next = stamps.find((stamp) => (stamp.index ?? 0) > index);
  return normalizeWhitespace(text.slice(index, next?.index ?? text.length));
}

function actionTypeForCompletedAction(action: { kind: NextActionKind; value?: string; label: string; name?: string }): string | null {
  if (action.kind === 'open') {
    const resolved = resolveIntentValue(action.value ?? '');
    if (resolved?.intent === 'maps') return 'maps_lookup';
    if (resolved?.intent === 'calendar') return 'calendar_event';
    if (resolved?.intent === 'gmail') return 'email';
  }
  if (action.kind === 'fill' || action.kind === 'select') {
    return actionTypeFor([action.name, action.label, action.value].filter(Boolean).join(' '));
  }
  return null;
}

function completedActionTerms(action: { value?: string; label: string; name?: string }): string[] {
  const terms = new Set<string>();
  const value = action.value ?? '';
  const resolved = resolveIntentValue(value);
  if (resolved) {
    for (const part of [resolved.entity.value, resolved.entity.location, resolved.entity.when]) {
      const text = normalizeWhitespace(part);
      if (text.length >= 2) terms.add(text);
    }
  } else {
    const text = normalizeWhitespace(value);
    if (text.length >= 2) terms.add(text);
  }
  for (const text of [action.name ?? '', action.label]) {
    const cleaned = normalizeWhitespace(text.replace(/^Fill .+ with /i, '').replace(/^Open /i, '').replace(/^Click /i, '').replace(/[“”"]/g, ''));
    if (cleaned.length >= 3 && cleaned.length <= 120) terms.add(cleaned);
  }
  return [...terms].slice(0, 6);
}

function taskFromHit(source: NonNullable<SearchHit['_source']>): TaskDoc | null {
  if (!source.groupKey || !source.text || !source.actionType || !isTaskStatus(source.status)) return null;
  return {
    groupKey: source.groupKey,
    tabId: source.tabId,
    actionType: source.actionType,
    status: source.status,
    text: source.text,
    texts: source.texts ?? [source.text],
    hosts: source.hosts ?? unique([source.host ?? hostOf(source.origin ?? '')]),
    sourceIds: source.sourceIds ?? [],
    timeValues: source.timeValues ?? [],
    placeValues: source.placeValues ?? [],
    firstSeenAt: source.firstSeenAt ?? source.lastSeenAt ?? source.at ?? new Date(0).toISOString(),
    lastSeenAt: source.lastSeenAt ?? source.at ?? new Date(0).toISOString(),
    ...(source.conflictReason ? { conflictReason: source.conflictReason } : {}),
    ...(source.conflictCount !== undefined ? { conflictCount: source.conflictCount } : {}),
  };
}

function taskLooksReusable(existing: TaskDoc, parsed: ParsedTask): boolean {
  if (existing.actionType !== parsed.actionType) return false;
  if (parsed.placeValues.length > 0 && existing.placeValues.length > 0) {
    return parsed.placeValues.some((place) => existing.placeValues.some((old) => keyText(old) === keyText(place)));
  }
  return true;
}

function isTaskStatus(status: unknown): status is TaskDoc['status'] {
  return status === 'unresolved' || status === 'conflict';
}

interface ParsedTask {
  groupKey: string;
  actionType: string;
  timeValues: string[];
  placeValues: string[];
}

function parseTask(text: string): ParsedTask {
  const cleaned = normalizeWhitespace(text);
  const actionType = actionTypeFor(cleaned);
  const place = extractPlace(cleaned);
  const email = cleaned.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? '';
  const anchor = place || email || extractCapitalPhrase(cleaned) || 'general';
  const date = extractDateBucket(cleaned);
  return {
    groupKey: slug(`${actionType}:${anchor}:${date}`),
    actionType,
    timeValues: extractTimes(cleaned),
    placeValues: place ? [place] : [],
  };
}

function actionTypeFor(text: string): string {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) || /\b(email|mail|reply|send)\b/i.test(text)) return 'email';
  const hasCalendarCue = /\b(dinner|lunch|breakfast|meeting|meet|call|appointment|event|calendar)\b/i.test(text);
  const hasWhen = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text);
  const hasTime = /\b(at|@)\s*(?:[01]?\d|2[0-3]|[1-9])(?::[0-5]\d)?\s*(?:am|pm)?\b/i.test(text);
  if (hasCalendarCue && (hasWhen || hasTime || /\b(event|calendar|appointment)\b/i.test(text))) return 'calendar_event';
  if (/\b(address|directions|map|maps|venue|cafe|restaurant|office|street|road|avenue|drive|near|nearby|around|things to do|side quests?)\b/i.test(text)) return 'maps_lookup';
  if (hasWhen && hasTime) return 'calendar_event';
  return 'follow_up';
}

function isActionableTaskType(actionType: string): boolean {
  return actionType === 'email' || actionType === 'calendar_event' || actionType === 'maps_lookup';
}

function extractPlace(text: string): string {
  const afterPrep = text.match(/\b(?:at|in|to|for|near|around)\s+(?:the\s+)?([A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*){0,5})(?=\s+(?:on|at|by|with|from|around|near|tomorrow|today|tonight)\b|[.,;]|$)/);
  return normalizeEntity(afterPrep?.[1] ?? '');
}

function extractCapitalPhrase(text: string): string {
  const match = text.match(/\b([A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*){1,4})\b/);
  return normalizeEntity(match?.[1] ?? '');
}

function extractDateBucket(text: string): string {
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
  if (iso) return iso;
  const day = text.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0];
  return day ? day.toLowerCase() : 'unscheduled';
}

function extractTimes(text: string): string[] {
  const matches = text.match(/\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s?(?:am|pm)\b|\b(?:[1-9]|1[0-2])(?::[0-5]\d)?(?=\s?(?:[.,;]|$))/gi) ?? [];
  return unique(matches.map((t) => t.toLowerCase().replace(/\s+/g, '')));
}

function normalizeEntity(text: string): string {
  return normalizeWhitespace(text)
    .replace(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*$/i, '')
    .trim();
}

function conflictFor(existing: TaskDoc | null, parsed: ParsedTask, text: string): string | undefined {
  if (!existing) return undefined;
  if (parsed.timeValues.some((t) => existing.timeValues.length > 0 && !existing.timeValues.includes(t))) return 'time_mismatch';
  if (parsed.placeValues.some((p) => existing.placeValues.length > 0 && !existing.placeValues.includes(p))) return 'place_mismatch';
  const normalized = keyText(text);
  return existing.texts.some((t) => keyText(t) !== normalized) && parsed.timeValues.length === 0 ? 'source_disagreement' : undefined;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items.filter(Boolean))];
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'task'
  );
}

function keyText(text: string): string {
  return normalizeWhitespace(text).toLowerCase().replace(/[.,;:!?'"()]/g, '');
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
