import type {
  ActionSuggestion,
  ContextItem,
  Eagerness,
  EagernessKnobs,
  ElementDescriptor,
  Entity,
  FieldDescriptor,
  FillSuggestion,
  InteractSuggestion,
  PageIntent,
  PageMeta,
  PageState,
  RequestContext,
  Settings,
  SuggestRequest,
  Suggestion,
} from '@carat/shared';
import {
  EAGERNESS,
  LIMITS,
  PAGE_SCROLL_NAME,
  PAGE_SCROLL_ROLE,
  PAGE_SOURCE,
  clickAllowed,
  fnv1a,
  impliedVerb,
  isDestructiveElement,
  isDestructiveName,
  isIntentName,
  isOffScreen,
  isPageScroll,
  isSiteLink,
  linkMatchesQuery,
  linkRelatesToQuery,
  mayPay,
  mergeSuggestions,
  pageIntent,
  pageJustifies,
  pageQueryClick,
  refusesFill,
  verbFits,
} from '@carat/shared';
import type { EntitySource, Provider, SuggestOptions } from '@carat/providers';
import { LocalProvider, RaceProvider, createProvider, createSmartProvider, matchEntities, nextStep } from '@carat/providers';
import type { InteractionView, RefineResponse, SuggestResponse, SuggestionSource, SuggestionView } from '../messaging';
import type { ContextStore, EntityStore } from '../store';
import { interactSuppressionKey, navSuppressionKey, suppressionPrefix } from '../store';
import type { AnswerOrigin, ProviderAttempt, SuggestDiag } from './diag';
import { fingerprintMatchesDescriptor } from './fingerprint';
import { flowActive } from './flow';
import { explainGate } from './gate';
import type { OpenTab } from './navigation';
import { resolveNavigation } from './navigation';
import { lookupPrewarmed } from './prewarm';
import type { RefineQueue, RefineTicket } from './refine';
import type { Requester } from './requester';
import { ownContext, scoreAndPickContext } from './score';
import type { VisionPipeline } from './vision';

export interface SuggestInput {
  page: PageMeta;
  fields: FieldDescriptor[];
  elements?: ElementDescriptor[];
  /** The page's kind, query, scroll position and what carat already did here. */
  state?: PageState;
  /** The user asked with the shortcut: ask the provider again and show what they dismissed. */
  force?: boolean;
}

export interface OrchestrateDeps {
  store: ContextStore;
  settings: () => Promise<Settings>;
  createProvider?: (settings: Settings) => Provider;
  localProvider?: Provider;
  now?: () => number;
  timeoutMs?: number;
  /** Told how each request went, for the popup's debug line: once at the reply and again when its ticket closes. */
  onDiag?: (diag: SuggestDiag) => void;
  /** The user's open tabs, read only to turn "open" into "focus". Never written to here. */
  tabs?: () => Promise<OpenTab[]>;
  /** Entities predicted at capture time; with them the first answer needs no call. */
  entities?: EntityStore;
  /** Where later answers go. Without it every request waits for the provider, as it did before the race. */
  refine?: RefineQueue;
  /** The smart second pass. `refine` and `vision` must both be present for one to start. */
  createSmartProvider?: (settings: Settings) => Provider | undefined;
  vision?: Pick<VisionPipeline, 'hasPending' | 'settled'>;
  smartTimeoutMs?: number;
}

const NONE: SuggestResponse = { suggestions: [], navigation: [], interactions: [] };

/**
 * One answer per snapshot: what the user will most likely do next on this
 * page. The first answer is whatever needs no waiting: the 60s cache, the
 * answer a navigation pre-warmed, the link the page's own query names, or the
 * network-free pass (the page's own priors, entities predicted when the text
 * was captured, and the regex provider). It goes back at once with a ticket,
 * and the configured providers race behind it; each later answer that would
 * change a chip is handed on through the ticket, the smart model last of all
 * when the answer is still weak. The provider is asked only when another
 * tab's text is in play or the local prior is under the level's floor. Only
 * when nothing is immediate does the reply wait, inside the 6s budget, for
 * the first provider to answer.
 */
export async function orchestrate(input: SuggestInput, requester: Requester, deps: OrchestrateDeps): Promise<SuggestResponse> {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? LIMITS.providerTimeoutMs;
  const started = Date.now();
  const { store } = deps;
  const diag: SuggestDiag = { at: now(), host: input.page.host, fields: input.fields.length, gate: 'ok' };

  const settings = await deps.settings();
  const { eagerness } = settings;
  diag.eagerness = eagerness;
  const items = await store.items();
  const elements = input.elements ?? [];
  diag.elements = elements.length;
  // What carat itself filled on this tab in the last minute; the only thing that earns a button a chip.
  const filled = requester.tabId === undefined ? [] : await store.recentFillSources(requester.tabId);
  // Freshness follows the store's clock, which stands still while pinned.
  const at = await store.clock();
  // Whether this page is a step in a flow: a checkout, or a form carat already filled on this page load.
  const flow = flowActive(input.page, input.state, filled.length > 0);
  diag.gate = explainGate({ ...input, elements, filled, flow }, settings);
  const smart = smartPath(settings, deps, requester);
  // What the user searched for on this page, and the links it names outright. Never a fill source.
  const intent = pageIntent(input.state, input.fields);
  const matched = intent ? elements.filter((e) => isSiteLink(e) && linkMatchesQuery(e, intent)) : [];
  if (intent && elements.some(isSiteLink)) {
    diag.query = intent.query;
    diag.linkMatched = matched.length;
  }
  const shape: Shape = { input, elements, filled, store, eagerness, flow, pay: mayPay(settings), intent, now };
  if (diag.gate !== 'ok') {
    deps.onDiag?.(diag);
    return { ...NONE };
  }

  const context = scoreAndPickContext(items, requester, at, eagerness);
  const own = ownContext(items, requester, at);
  // What the page alone says to do next, and how sure of it the level lets carat be.
  const step = nextStep(request(shape, context, own, now()), eagerness);
  if (step.kind) {
    diag.pageKind = step.kind;
    diag.prior = step.reason;
  }
  if (context.length === 0 && own.length === 0 && step.best === 0 && !matched[0]) {
    const result: SuggestResponse = { ...NONE };
    // Nothing to answer from and no prior, but a screenshot is being transcribed: the smart pass alone may have an answer.
    if (smart?.pending) {
      const ticket = smart.queue.open(requester.tabId);
      void smartSuggest(shape, requester, smart, deps, now)
        .then(async (out) => {
          if (!out) return;
          const merged = mergeSuggestions([], out.answer);
          await store.setCached(out.key, merged);
          const offered = await offer(merged, shape, out.context, out.own);
          ticket.push({ suggestions: offered.fills, interactions: offered.interactions });
        })
        .catch(() => undefined)
        .finally(() => ticket.close());
      result.ticket = ticket.id;
      diag.refine = true;
      diag.smart = true;
    }
    deps.onDiag?.(diag);
    return result;
  }


  const key = cacheKey(shape, context, own);
  // Counted whether a provider or `valid` dropped them, on the first answer and on every later one; a provider never returns what it dropped.
  const bump = (): void => void (diag.underFloor = (diag.underFloor ?? 0) + 1);
  const pass: Pass = { shape, requester, context, own, key, settings, smart, diag, deps, now, timeoutMs, started, bump };

  let cached = input.force ? undefined : await store.getCached(key);
  diag.cached = cached !== undefined;
  // A Save chip is due when something was just filled, and a forced request wants a fresh answer: neither takes the warmed one.
  if (!cached && !input.force && filled.length === 0) {
    const warmed = await lookupPrewarmed(store, input.page, input.fields, context);
    if (warmed) {
      cached = warmed;
      diag.prewarmed = true;
      // Under the exact key too, so the next request and the refine path see one entry.
      await store.setCached(key, warmed);
    }
  }
  if (cached) {
    diag.source = diag.prewarmed ? 'prewarm' : 'cache';
    // The key ignores what is scrolled into view, so a cached scroll may now name an on-screen element.
    // The floor was already applied when the answer was cached, so nothing is counted here.
    const suggestions = valid(cached, shape, context, own);
    const offered = await offer(suggestions, shape, context, own);
    // A warmed answer came from the fast model and may be weak; a cached one already had its second opinion.
    const fresh = !diag.cached;
    const follow = wantsSmart(pass, offered, fresh) ? (r: Refinement) => secondOpinion(pass, r, fresh) : undefined;
    return finish(pass, suggestions, offered, follow);
  }

  // The first result whose site or title is what the user searched for needs no
  // model and no network, so it answers before the race is ever started.
  if (intent && matched[0]) {
    const link = valid([pageQueryClick(matched[0], intent)], shape, context, own, bump);
    const linkOffered = await offer(link, shape, context, own);
    if (linkOffered.interactions.length > 0) {
      diag.attempts = [];
      await store.setCached(key, link);
      return finish(pass, link, linkOffered);
    }
  }

  // What the page kind alone justifies, once it clears the level's prior floor,
  // needs no model either: a checkout's Continue, a feed's next screen. With no
  // text from any tab and no query typed here there is nothing a model could add,
  // so it answers outright; otherwise the prior goes up at once and the providers
  // refine behind the ticket, since they may know a better step than the page does.
  if (step.suggestions.length > 0) {
    const prior = valid(step.suggestions, shape, context, own, bump);
    const priorOffered = await offer(prior, shape, context, own);
    const hasText = context.length > 0 || own.length > 0 || intent !== null;
    if ((priorOffered.fills.length > 0 || priorOffered.interactions.length > 0) && (deps.refine || !hasText)) {
      diag.source = 'prior';
      diag.attempts = [];
      await store.setCached(key, prior);
      const behind = request(shape, context, own, now());
      const follow = deps.refine && hasText ? (r: Refinement) => withSmart(pass, r, () => providerPass(pass, behind, r, prior)) : undefined;
      return finish(pass, prior, priorOffered, follow);
    }
  }

  const req = request(shape, context, own, now());
  // Tab offers alone come from the page's own text and are never refined, so they take the provider path as before.
  if (deps.refine && context.length > 0) {
    const quick = await quickAnswer(req, pass, items, at);
    const offered = await offer(quick.suggestions, shape, context, own);
    if (offered.fills.length > 0 || offered.interactions.length > 0) {
      diag.source = quick.origin;
      return finish(pass, quick.suggestions, offered, (r) => withSmart(pass, r, () => providerPass(pass, req, r, quick.suggestions)));
    }
  }

  const outcome = await callProvider(req, settings, deps, timeoutMs, deps.refine !== undefined, bump);
  diag.attempts = outcome.attempts;
  if (outcome.origin) diag.source = outcome.origin;
  const suggestions = valid(outcome.suggestions, shape, context, own, bump);
  // A transport error or timeout is not "nothing to suggest": caching it
  // would hide chips for a minute after one blip. Only a real answer is kept.
  if (!outcome.failed) await store.setCached(key, suggestions);
  const offered = await offer(suggestions, shape, context, own);
  const { later } = outcome;
  const follow =
    later || wantsSmart(pass, offered, true)
      ? (r: Refinement) =>
          withSmart(pass, r, async () => {
            if (!later) return;
            await later.drain((view) => r.land(valid(view, shape, context, own, bump)));
            diag.attempts = later.attempts();
            if (!later.failed()) await store.setCached(key, r.merged);
          })
      : undefined;
  return finish(pass, suggestions, offered, follow);
}

/** The parts of one request that both passes share. */
interface Shape {
  input: SuggestInput;
  elements: ElementDescriptor[];
  filled: string[];
  store: ContextStore;
  eagerness: Eagerness;
  /** A stored task marks this page as a step in an ongoing flow. */
  flow: boolean;
  /** Money controls may be offered (the setting, through `mayPay`). */
  pay: boolean;
  /** The page's own query, when it has one; the only thing that lets a link be clicked with nothing filled. */
  intent: PageIntent | null;
  now: () => number;
}

/** Everything one request settled before its first answer, shared by the reply and what runs on behind it. */
interface Pass {
  shape: Shape;
  requester: Requester;
  context: RequestContext;
  own: RequestContext;
  key: string;
  settings: Settings;
  smart: SmartPath | undefined;
  diag: SuggestDiag;
  deps: OrchestrateDeps;
  now: () => number;
  timeoutMs: number;
  started: number;
  /** Counts one more candidate dropped under the level's floor, for the popup's line. */
  bump: () => void;
}

type Offered = Awaited<ReturnType<typeof offer>>;

/**
 * Build the reply and, when something still runs behind it, hand out a ticket
 * and start it. The ticket closes when the follow-up is done, and the popup's
 * line is reported again then with the later attempts.
 */
async function finish(pass: Pass, suggestions: Suggestion[], offered: Offered, follow?: (r: Refinement) => Promise<void>): Promise<SuggestResponse> {
  const { deps, requester, shape, diag } = pass;
  const tabs = offered.actions.length > 0 ? await (deps.tabs ?? noTabs)().catch(() => []) : [];
  const navigation = resolveNavigation(offered.actions, tabs, requester, shape.input.page)
    .slice(0, LIMITS.maxNavigations)
    .map(offered.withSource);
  const result: SuggestResponse = { suggestions: offered.fills, navigation, interactions: offered.interactions };
  diag.ms = Date.now() - pass.started;
  diag.offered = result.suggestions.length;
  diag.navigation = navigation.length;
  diag.interactions = result.interactions.length;
  if (follow && deps.refine) {
    const ticket = deps.refine.open(requester.tabId);
    const refinement = new Refinement(pass, suggestions, offered, ticket);
    result.ticket = ticket.id;
    diag.refine = true;
    void follow(refinement)
      .catch(() => undefined)
      .finally(() => {
        ticket.close();
        diag.refined = refinement.pushed;
        deps.onDiag?.(diag);
      });
  }
  deps.onDiag?.(diag);
  return result;
}

/**
 * What the content script has been told so far, and the door to tell it
 * more. Each later answer replaces the merged view and the cache entry, but
 * only reaches the page when a chip would show a different value: the
 * content script's own merge refuses a lower confidence anyway, and a
 * same-value answer would only redraw the chip.
 */
class Refinement {
  merged: Suggestion[];
  offered: Offered;
  pushed = 0;
  private sent: string;

  constructor(
    private readonly pass: Pass,
    shown: Suggestion[],
    offered: Offered,
    private readonly ticket: RefineTicket,
  ) {
    this.merged = shown;
    this.offered = offered;
    this.sent = signature(offered);
  }

  /** Fold a later answer in. `live` is the context it was answered from when that differs from the request's. */
  async land(merged: Suggestion[], live?: { context: RequestContext; own: RequestContext; key: string }): Promise<void> {
    const { shape, context, own, key } = this.pass;
    this.merged = merged;
    await shape.store.setCached(key, merged);
    if (live && live.key !== key) await shape.store.setCached(live.key, merged);
    this.offered = await offer(merged, shape, live?.context ?? context, live?.own ?? own);
    const sig = signature(this.offered);
    if (sig === this.sent) return;
    this.sent = sig;
    this.pushed++;
    this.ticket.push({ suggestions: this.offered.fills, interactions: this.offered.interactions });
  }
}

/** What a chip would show: each offered field's value and each element's verb and value, in a fixed order. */
function signature(offered: Offered): string {
  const fills = offered.fills.map((s) => `f|${s.fieldId}=${s.value}`).sort();
  const interactions = offered.interactions.map((s) => `e|${s.elementId}=${s.verb}:${s.value}`).sort();
  return [...fills, ...interactions].join('\n');
}

interface QuickAnswer {
  suggestions: Suggestion[];
  origin: AnswerOrigin;
}

/**
 * The answer that needs no network: the entities predicted when each context
 * item was captured, paired with the page's fields and controls, folded with
 * the regex provider's pass over the same text. The regex answer keeps a tie,
 * since the regex-derived entities say the same thing at the same confidence.
 */
async function quickAnswer(req: SuggestRequest, pass: Pass, items: ContextItem[], at: number): Promise<QuickAnswer> {
  const { deps, shape, context, own, settings, bump } = pass;
  const { input, elements } = shape;
  const lists = deps.entities ? await deps.entities.forItems(items, at) : new Map<string, Entity[]>();
  const sources: EntitySource[] = context.map((c) => ({ id: c.id, origin: c.origin, entities: lists.get(c.id) ?? [] }));
  const fromEntities = sources.some((s) => s.entities.length > 0) ? matchEntities(sources, input.fields, elements, input.page, shape.eagerness) : [];
  let fromLocal: Suggestion[] = [];
  try {
    fromLocal = await (deps.localProvider ?? new LocalProvider(settings.eagerness)).suggest(req, { signal: AbortSignal.timeout(pass.timeoutMs), onUnderFloor: bump });
  } catch {
    // the regex pass is optional here; the race asks it again
  }
  const suggestions = valid(mergeSuggestions(fromLocal, fromEntities), shape, context, own, bump);
  const top = suggestions.find((s) => s.kind !== 'action');
  return { suggestions, origin: top && fromEntities.includes(top) ? 'entities' : 'local' };
}

/**
 * The configured providers, behind a quick answer already on screen. The
 * quick answer keeps a tie: the regex provider inside the race is the same
 * one that produced it, and an entity match is only replaced by a surer
 * value, which is all the content script would accept anyway.
 */
async function providerPass(pass: Pass, req: SuggestRequest, r: Refinement, quick: Suggestion[]): Promise<void> {
  const { settings, deps, timeoutMs, diag, shape, context, own, key, bump } = pass;
  const outcome = await callProvider(req, settings, deps, timeoutMs, true, bump);
  diag.attempts = outcome.attempts;
  const fold = (view: Suggestion[]): Suggestion[] => mergeSuggestions(valid(view, shape, context, own, bump), quick);
  if (!outcome.failed) await r.land(fold(outcome.suggestions));
  if (!outcome.later) return;
  await outcome.later.drain((view) => r.land(fold(view)));
  diag.attempts = outcome.later.attempts();
  // The quick answer is cached only once a network provider has had its say; a failed one leaves nothing behind.
  if (!outcome.later.failed()) await shape.store.setCached(key, r.merged);
}

/**
 * The smart pass starts at once when a transcript is on its way, since it
 * waits for that anyway; otherwise it starts after the providers have
 * answered, so a sure answer from the fast model spares the call.
 */
async function withSmart(pass: Pass, r: Refinement, main: () => Promise<void>): Promise<void> {
  const early = pass.smart?.pending ? secondOpinion(pass, r, true) : undefined;
  await main();
  await (early ?? secondOpinion(pass, r, true));
}

interface SmartPath {
  provider: Provider;
  queue: RefineQueue;
  vision: Pick<VisionPipeline, 'hasPending' | 'settled'>;
  /** A screenshot from another tab is being read right now. */
  pending: boolean;
}

function smartPath(settings: Settings, deps: OrchestrateDeps, requester: Requester): SmartPath | undefined {
  if (!settings.screenshots || !deps.refine || !deps.vision) return undefined;
  let provider: Provider | undefined;
  try {
    provider = (deps.createSmartProvider ?? createSmartProvider)(settings);
  } catch {
    return undefined;
  }
  if (!provider) return undefined;
  return { provider, queue: deps.refine, vision: deps.vision, pending: deps.vision.hasPending(requester) };
}

/**
 * Only a fresh answer, or one a transcript may still improve, is worth a
 * second opinion; and only when there is (or will be) other tabs' text to
 * answer from, since tab offers are never refined; and only when what is
 * shown is weak.
 */
function wantsSmart(pass: Pass, offered: Offered, fresh: boolean): boolean {
  const { smart, context } = pass;
  if (!smart || !(context.length > 0 || smart.pending) || !(fresh || smart.pending)) return false;
  return weak([...offered.fills, ...offered.interactions]);
}

/** Nothing shown, or nothing the model was sure of. */
function weak(shown: Array<{ confidence: number }>): boolean {
  return shown.every((s) => s.confidence < LIMITS.smartBelowConfidence);
}

async function secondOpinion(pass: Pass, r: Refinement, fresh: boolean): Promise<void> {
  const { smart, shape, requester, deps, now, diag } = pass;
  if (!smart || !wantsSmart(pass, r.offered, fresh)) return;
  diag.smart = true;
  const out = await smartSuggest(shape, requester, smart, deps, now, pass.bump);
  // Folded over whatever has landed since it was asked: per field or element the surer one wins.
  if (out) await r.land(mergeSuggestions(r.merged, out.answer), out);
}

interface SmartAnswer {
  answer: Suggestion[];
  context: RequestContext;
  own: RequestContext;
  /** The cache key for the context it was answered from. */
  key: string;
}

/**
 * Wait for any screenshot still being read (it is the context most likely to
 * change the answer), re-pick context, and ask the smart model. Undefined
 * when it could not answer: no context, out of budget, or a failed call.
 */
async function smartSuggest(
  shape: Shape,
  requester: Requester,
  smart: SmartPath,
  deps: OrchestrateDeps,
  now: () => number,
  onUnderFloor?: () => void,
): Promise<SmartAnswer | undefined> {
  const budget = deps.smartTimeoutMs ?? LIMITS.smartTimeoutMs;
  const deadline = Date.now() + budget;
  // Leave the model at least a fifth of the budget however long the transcription takes.
  await Promise.race([smart.vision.settled(), sleep(budget * 0.8)]);

  const { store, eagerness } = shape;
  const items = await store.items();
  const at = await store.clock();
  const context = scoreAndPickContext(items, requester, at, eagerness);
  const own = ownContext(items, requester, at);
  const remaining = deadline - Date.now();
  if (context.length === 0 || remaining < MIN_SMART_MS) return undefined;

  try {
    const raw = await withTimeout(smart.provider, request(shape, context, own, now()), remaining, onUnderFloor);
    const answer = valid(raw, shape, context, own, onUnderFloor);
    return { answer, context, own, key: cacheKey(shape, context, own) };
  } catch {
    return undefined;
  }
}

const MIN_SMART_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(shape: Shape, context: RequestContext, own: RequestContext, now: number): SuggestRequest {
  const { input, elements, filled, flow } = shape;
  return {
    page: input.page,
    fields: input.fields,
    ...(elements.length > 0 ? { elements } : {}),
    ...(filled.length > 0 ? { filled } : {}),
    ...(input.state ? { state: input.state } : {}),
    // `own` first: the page the user is looking at is the closest source, and the prompt says to read it first.
    ...(own.length > 0 ? { own } : {}),
    context,
    ...(flow ? { flow: true as const } : {}),
    now: new Date(now).toISOString(),
    ...(typeof navigator !== 'undefined' && navigator.language ? { locale: navigator.language } : {}),
  };
}

/**
 * What the chip may show: minus what the user already accepted or dismissed
 * (unless they asked out loud), one per field, element or intent, capped by
 * the eagerness level (two, or four at eager), each tagged with where its
 * text came from. The content script shows one at a time and moves to the
 * next after Tab or Esc.
 */
async function offer(suggestions: Suggestion[], shape: Shape, context: RequestContext, own: RequestContext) {
  const { input, elements, store } = shape;
  const cap = EAGERNESS[shape.eagerness].maxSuggestions;
  const suppressed = input.force ? [] : await store.suppressedKeys();
  const fills = suggestions.filter(isFill).filter((s) => !isSuppressed(s, input, suppressed));
  const actions = suggestions.filter(isAction).filter((a) => !suppressed.includes(navSuppressionKey(a.intent, a.value)));
  const interactions = suggestions.filter(isInteract).filter((s) => {
    if (isPageScroll(s)) return !suppressed.includes(interactSuppressionKey(input.page.host, PAGE_SCROLL_ROLE, PAGE_SCROLL_NAME));
    const el = elements.find((e) => e.i === s.elementId);
    return !!el && !suppressed.includes(interactSuppressionKey(input.page.host, el.r, el.nm));
  });
  const sources = new Map([...context, ...own].map((c) => [c.id, sourceOf(c)] as const));
  // A click the page's own query justifies came from this page, just now.
  if (shape.intent) sources.set(PAGE_SOURCE, { host: input.page.host, capturedAt: shape.now() });
  const withSource = <T extends { sourceContextId: string }>(s: T): T & { source?: SuggestionSource } => ({
    ...s,
    ...(sources.has(s.sourceContextId) ? { source: sources.get(s.sourceContextId) } : {}),
  });
  return {
    fills: topPerField(fills).slice(0, cap).map(withSource) as SuggestionView[],
    actions: topPerIntent(actions),
    interactions: topPerElement(interactions).slice(0, cap).map(withSource) as InteractionView[],
    withSource,
  };
}

// The chip may say where a value came from; the text it came from stays here.
function sourceOf(c: RequestContext[number]): SuggestionSource {
  let host = c.origin;
  try {
    host = new URL(c.origin).host;
  } catch {
    // origin is already a bare host
  }
  return { host, capturedAt: c.capturedAt };
}

export interface ProviderOutcome {
  suggestions: Suggestion[];
  attempts: ProviderAttempt[];
  /** True when the provider the user configured never gave an answer. */
  failed: boolean;
  /** Which provider the answer came from, when one did. */
  origin?: AnswerOrigin;
  /** A race still running: later answers, each the whole merged view, until every provider settles or the budget ends. */
  later?: {
    drain(onView: (view: Suggestion[]) => Promise<void>): Promise<void>;
    /** Every provider's record so far. */
    attempts(): ProviderAttempt[];
    /** True while no network provider has given an answer. */
    failed(): boolean;
  };
}

const noTabs = async (): Promise<OpenTab[]> => [];
const isFill = (s: Suggestion): s is FillSuggestion => s.kind === 'fill';
const isAction = (s: Suggestion): s is ActionSuggestion => s.kind === 'action';
const isInteract = (s: Suggestion): s is InteractSuggestion => s.kind === 'interact';

/**
 * One 6s budget covers the whole call. With `askModel` false the local
 * predictor answers alone, which is the common case on a results page or an
 * article with nothing read in another tab: the prior already clears the
 * level's floor, so a network call could only confirm it. Otherwise a race
 * (the real factory's answer whenever a network provider is configured)
 * resolves with its first non-empty answer and keeps the rest running behind
 * `later` when there is a queue to `stream` them through; without one it runs
 * to the end and answers with the merged view, as one call did before. A plain
 * provider is asked once; a failing network provider degrades to the regex
 * provider on whatever budget is left (with a small floor, since the regex
 * pass is near-instant), and a slow local provider degrades to nothing.
 */
async function callProvider(
  req: SuggestRequest,
  settings: Settings,
  deps: OrchestrateDeps,
  timeoutMs: number,
  stream: boolean,
  onUnderFloor?: SuggestOptions['onUnderFloor'],
  askModel = true,
): Promise<ProviderOutcome> {
  const local = deps.localProvider ?? new LocalProvider(settings.eagerness);
  const deadline = Date.now() + timeoutMs;
  const floor = Math.min(FALLBACK_FLOOR_MS, timeoutMs);
  const attempts: ProviderAttempt[] = [];

  if (!askModel) {
    const only = await attempt(local, req, timeoutMs, onUnderFloor);
    attempts.push(only);
    return { suggestions: only.suggestions, attempts, failed: only.error !== undefined };
  }

  let provider: Provider;
  try {
    provider = (deps.createProvider ?? createProvider)(settings);
  } catch (e) {
    attempts.push({ id: settings.provider, ms: 0, count: 0, error: describeError(e) });
    provider = local;
  }
  if (provider instanceof RaceProvider) {
    return stream ? raceProvider(provider, req, timeoutMs, attempts, onUnderFloor) : raceToEnd(provider, req, timeoutMs, attempts, onUnderFloor);
  }

  const first = await attempt(provider, req, timeoutMs, onUnderFloor);
  attempts.push(first);
  if (!first.error) {
    // An empty answer from the network provider with no key configured means
    // it was never really asked; give the regex pass a turn.
    if (first.count > 0 || provider.id === 'local' || settings.apiKey) {
      return { suggestions: first.suggestions, attempts, failed: false, ...(first.count > 0 ? { origin: originOf(provider.id) } : {}) };
    }
  } else if (provider.id === 'local') {
    return { suggestions: [], attempts, failed: true };
  }

  const second = await attempt(local, req, Math.max(floor, deadline - Date.now()), onUnderFloor);
  attempts.push(second);
  return { suggestions: second.suggestions, attempts, failed: first.error !== undefined, ...(second.count > 0 ? { origin: 'local' } : {}) };
}

/**
 * `first()` never rejects and the regex provider answers within a microtask,
 * so nothing wraps it; the signal is the one budget for every provider in
 * the race. The regex answer counts as failed until a network provider has
 * answered, so it is not cached over a call that then fails.
 */
async function raceProvider(
  race: RaceProvider,
  req: SuggestRequest,
  timeoutMs: number,
  attempts: ProviderAttempt[],
  onUnderFloor?: SuggestOptions['onUnderFloor'],
): Promise<ProviderOutcome> {
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(new DOMException('budget', 'TimeoutError')), timeoutMs);
  const suggestions = await race.first(req, controller.signal, onUnderFloor);
  const answered = (): boolean => race.attempts.some((a) => a.id !== 'local' && !a.error);
  const winner = race.attempts.find((a) => a.count > 0 && !a.error);
  const running = !controller.signal.aborted && race.attempts.length < race.providers.length;
  if (!running) clearTimeout(budget);
  return {
    suggestions,
    attempts: [...attempts, ...race.attempts],
    failed: !answered(),
    ...(winner ? { origin: originOf(winner.id) } : {}),
    ...(running
      ? {
          later: {
            async drain(onView) {
              try {
                for await (const { suggestions: view } of race.rest()) await onView(view);
              } finally {
                clearTimeout(budget);
              }
            },
            attempts: () => [...attempts, ...race.attempts],
            failed: () => !answered(),
          },
        }
      : {}),
  };
}

/** The whole race inside the budget; the merged view is the answer, and the surest network provider that answered is its origin. */
async function raceToEnd(
  race: RaceProvider,
  req: SuggestRequest,
  timeoutMs: number,
  attempts: ProviderAttempt[],
  onUnderFloor?: SuggestOptions['onUnderFloor'],
): Promise<ProviderOutcome> {
  const suggestions = await race.suggest(req, { signal: AbortSignal.timeout(timeoutMs), ...(onUnderFloor ? { onUnderFloor } : {}) });
  const landed = race.attempts;
  const network = landed.filter((a) => a.id !== 'local' && !a.error);
  const winner = [...network].reverse().find((a) => a.count > 0) ?? landed.find((a) => a.count > 0 && !a.error);
  return { suggestions, attempts: [...attempts, ...landed], failed: network.length === 0, ...(winner ? { origin: originOf(winner.id) } : {}) };
}

function originOf(id: Settings['provider']): AnswerOrigin {
  return id === 'local' ? 'local' : id === 'cloudflare' ? 'jev' : 'chat';
}

const FALLBACK_FLOOR_MS = 1000;

async function attempt(
  provider: Provider,
  req: SuggestRequest,
  timeoutMs: number,
  onUnderFloor?: SuggestOptions['onUnderFloor'],
): Promise<ProviderAttempt & { suggestions: Suggestion[] }> {
  const started = Date.now();
  try {
    const suggestions = await withTimeout(provider, req, timeoutMs, onUnderFloor);
    return { id: provider.id, ms: Date.now() - started, count: suggestions.length, suggestions };
  } catch (e) {
    return { id: provider.id, ms: Date.now() - started, count: 0, error: describeError(e), suggestions: [] };
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.name === 'TimeoutError' ? 'timed out' : e.message || e.name;
  return String(e);
}

// Races the signal as well as passing it: a provider that ignores abort still cannot hold the chip past the budget.
function withTimeout(provider: Provider, req: SuggestRequest, timeoutMs: number, onUnderFloor?: SuggestOptions['onUnderFloor']): Promise<Suggestion[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise<Suggestion[]>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    provider.suggest(req, { signal, ...(onUnderFloor ? { onUnderFloor } : {}) }).then(resolve, reject);
  });
}

/**
 * Fills must name an empty field and cite text the user read, this page's own
 * or another tab's, and must not read the field or the page back to itself.
 * Actions must cite the page's own text; interactions must name a described
 * element with a verb that fits its role and state, cite text, a recent fill
 * or the page state, and never a destructive name. A button or link is
 * clicked only after carat filled something on the page, when it is the
 * primary action and the level or a flow allows that (`clickAllowed`), or
 * where the page kind justifies it; a money control only when `mayPay` says
 * so. A real link cited to the page itself also has to have something to do
 * with the page's query, when it has one. A scroll to an element that is
 * already on-screen becomes the verb it stood in for, or nothing. Whatever
 * passes all that but sits under the level's confidence floor is dropped and
 * counted.
 */
function valid(suggestions: Suggestion[], shape: Shape, context: RequestContext, own: RequestContext, onUnderFloor?: () => void): Suggestion[] {
  const { input, elements, filled, intent } = shape;
  const knobs: EagernessKnobs = EAGERNESS[shape.eagerness];
  const contextIds = new Set(context.map((c) => c.id));
  const ownIds = new Set(own.map((o) => o.id));
  const fillIds = new Set([...contextIds, ...ownIds]);
  const interactIds = new Set([...fillIds, ...filled]);
  const gate = { filled: filled.length > 0, flow: shape.flow, eagerness: shape.eagerness, fillable: input.fields.some((f) => !f.v) };
  const wellFormed = (s: Suggestion): boolean => {
    if (typeof s.value !== 'string') return false;
    const bare = s.kind === 'interact' && s.verb === 'scroll';
    if (!bare && s.value.trim().length === 0) return false;
    if (s.kind === 'action') return isIntentName(s.intent) && ownIds.has(s.sourceContextId);
    if (s.kind === 'interact') {
      // A page scroll names no element; only the page state can justify it.
      if (isPageScroll(s)) return pageJustifies('scroll', undefined, input.state, input.fields);
      const el = elements.find((e) => e.i === s.elementId);
      if (!el || isDestructiveElement(el)) return false;
      if (el.m === 1 && !shape.pay) return false;
      if (!verbFits(el, s.verb, s.value.trim())) return false;
      if (s.sourceContextId === PAGE_SOURCE) {
        if (!pageJustifies(s.verb, el, input.state, input.fields)) return false;
        // A link the page itself justifies still has to have something to do with what was searched for here.
        return !isSiteLink(el) || intent === null || linkRelatesToQuery(el, intent);
      }
      if (!interactIds.has(s.sourceContextId)) return false;
      if (s.verb === 'click' && !clickAllowed(el, gate)) return pageJustifies('click', el, input.state, input.fields);
      return true;
    }
    const field = input.fields.find((f) => f.i === s.fieldId);
    if (!field || field.v || !fillIds.has(s.sourceContextId)) return false; // never over what the user typed
    // The page's own text may fill a field on it; the page's own furniture may not.
    return !refusesFill(s.value, field, input.page, ownIds.has(s.sourceContextId));
  };
  return suggestions.flatMap((raw): Suggestion[] => {
    // Settle scrolls first, so a scroll rewritten to a click faces the click rules and the floor like any other.
    const s = raw.kind === 'interact' ? settleScroll(raw, elements) : raw;
    if (!s || !wellFormed(s)) return [];
    if (s.confidence >= knobs.minConfidence) return [s];
    onUnderFloor?.();
    return [];
  });
}

/**
 * A `scroll` only means something for an element that is off-screen; carat
 * scrolls to an on-screen one's chip by itself. So a scroll to an on-screen
 * element is rewritten to the one verb the element implies (click a button,
 * check a box), which then faces the same checks as if the model had said
 * so, or dropped when the element needs a value (slider, select).
 */
function settleScroll(s: InteractSuggestion, elements: ElementDescriptor[]): InteractSuggestion | null {
  if (s.verb !== 'scroll' || isPageScroll(s)) return s;
  const el = elements.find((e) => e.i === s.elementId);
  if (!el) return null;
  if (isOffScreen(el)) return s;
  const verb = impliedVerb(el);
  return verb ? { ...s, verb, value: el.nm } : null;
}

function isSuppressed(s: FillSuggestion, input: SuggestInput, keys: string[]): boolean {
  const field = input.fields.find((f) => f.i === s.fieldId);
  if (!field) return true;
  const prefix = suppressionPrefix(s.sourceContextId, input.page.host);
  return keys.some((k) => k.startsWith(prefix) && fingerprintMatchesDescriptor(k.slice(prefix.length), field));
}

function topPerField(suggestions: FillSuggestion[]): FillSuggestion[] {
  return topBy(suggestions, (s) => s.fieldId);
}

function topPerIntent(actions: ActionSuggestion[]): ActionSuggestion[] {
  return topBy(actions, (a) => a.intent);
}

function topPerElement(interactions: InteractSuggestion[]): InteractSuggestion[] {
  return topBy(interactions, (s) => s.elementId || PAGE_SCROLL_ROLE);
}

function topBy<T extends { confidence: number }>(list: T[], keyOf: (t: T) => string): T[] {
  const best = new Map<string, T>();
  for (const s of list) {
    const cur = best.get(keyOf(s));
    if (!cur || s.confidence > cur.confidence) best.set(keyOf(s), s);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

function cacheKey(shape: Shape, context: RequestContext, own: RequestContext): string {
  const { input, elements, filled, eagerness: level, flow, pay } = shape;
  // The click and money rules are part of the key: an answer filtered without a flow is not the answer with one.
  const eagerness = `${level}${flow ? '+flow' : ''}${pay ? '+pay' : ''}`;
  // Focus, width and what is scrolled into view change as the user moves around without changing what to suggest.
  const fields = input.fields.map(({ f: _f, w: _w, o: _o, ...rest }) => rest);
  const els = elements.map(({ o: _o, ...rest }) => rest);
  // Context and own ids are kept apart: the same item is a fill source for one tab and the page's own text for another.
  const ids = `${context.map((c) => c.id).join(',')}|${own.map((c) => c.id).join(',')}`;
  // The page state is part of the question: what is left to do here changes as the user scrolls and accepts.
  const state = input.state ? `${input.state.kind}|${input.state.q ?? ''}|${input.state.more}|${(input.state.done ?? []).join(',')}` : '';
  // The level is part of the key: a cached answer was filtered at the floor of the level that asked.
  return fnv1a(`${input.page.host}|${eagerness}|${state}|${JSON.stringify(fields)}|${JSON.stringify(els)}|${filled.join(',')}|${ids}`).toString(36);
}
