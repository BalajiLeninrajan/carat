import type { ContextItem } from '@carat/shared';
import { domainLabel, normalizeWhitespace, registrableDomain, truncate } from '@carat/shared';
import type { CandidateKind } from '@carat/providers';
import { candidatesFrom } from '@carat/providers';
import { relativeAge } from '../format/age';
import type { StorageArea } from '../store/storage-area';
import type { NoteDiag, NoteVerdict } from './diag';
import type { Requester } from './requester';

/** How a regex candidate reads as a fact, when there is no model to write one. */
const CANDIDATE_FACT: Record<CandidateKind, string> = {
  email: 'email address',
  phone: 'phone number',
  address: 'street address',
  place: 'place',
  plan: 'plan',
  event: 'event',
  name: 'name',
};

/** Session key for the distilled notes, beside the context store's own keys. */
export const NOTES_KEY = 'notes';

export const NOTES_LIMITS = {
  /** Facts kept from one reading of one page. */
  perPage: 5,
  /** Notes in all, oldest first out. */
  max: 40,
  ttlMs: 60 * 60_000,
  /** Notes the request carries. */
  top: 8,
  /** Past this a note is old news: the page in front of the user outweighs it. */
  oldMs: 30 * 60_000,
  /** How many old notes a request carries. The rest are dropped rather than ranked last. */
  oldMax: 2,
  factChars: 200,
  /** Text under this is not worth a model call: a page that short is a step, not a read. */
  minTextChars: 200,
  /** A page left inside this was passed through on the way somewhere else. */
  minDwellMs: 3000,
  /** How long the distiller has before the offline path answers instead. */
  timeoutMs: 6000,
} as const;

export interface Note {
  at: number;
  /** The origin the fact was read on; notes are kept per origin. */
  origin: string;
  tabId: number;
  title: string;
  text: string;
}

/** The provider's distiller. The engine side implements it; without one the regex path answers. */
export type Distill = (text: string, host: string, signal: AbortSignal) => Promise<string[]>;

export interface NotesDeps {
  area: StorageArea;
  distill?: Distill;
  /** While the store is pinned nothing new is remembered, as with every other capture. */
  pinned?: () => Promise<boolean>;
  /** Why the page a tab left did or did not become notes; the popup's line and the panel's timeline. */
  onDiag?: (tabId: number, diag: NoteDiag) => void;
  now?: () => number;
  timeoutMs?: number;
}

export interface Notes {
  /**
   * A page was captured. The text is held per tab and distilled when the user
   * leaves the tab, which is when it is finished being read.
   */
  onCapture(item: ContextItem, leaving?: boolean): void;
  /** The tab went to the background: distil whatever it last captured. */
  onTabHidden(tabId: number): Promise<void>;
  /** Distil now and wait: the tab-hide path, and what the tests drive. */
  distilNow(item: ContextItem): Promise<Note[]>;
  /** The newest facts from other tabs, then this tab's own older ones, marked. */
  top(requester: Pick<Requester, 'tabId'>, now?: number): Promise<string[]>;
  /** The newest `n` facts across every tab, newest first. What the goal is derived from. */
  newest(n: number, now?: number): Promise<string[]>;
  sweep(): Promise<void>;
  clear(): Promise<void>;
  /** Resolves once every queued write has landed. */
  flush(): Promise<void>;
}

/**
 * What the user read in other tabs, boiled down to facts they might act on
 * here. On tab-hide the page's captured text goes to `deps.distill`, which
 * answers with at most five self-contained sentences; when there is no
 * distiller, or it fails or times out, the regex candidate list stands in so
 * the offline path still has something to offer. Notes live in
 * `chrome.storage.session` for an hour, forty at most, deduped by their
 * normalised text, and a fresh reading of a page replaces what that page said
 * before.
 *
 * Everything that decides whether a page may be read at all (the denylist, a
 * visible password field, the per-site switch, the pin) is settled before
 * `onCapture` is ever reached: it takes the item the context store accepted.
 */
export function createNotes(deps: NotesDeps): Notes {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? NOTES_LIMITS.timeoutMs;
  const pending = new Map<number, ContextItem>();
  /** Per origin, the text hash last distilled: a page re-captured unchanged is not read twice. */
  const done = new Map<string, number>();
  let chain: Promise<unknown> = Promise.resolve();

  const edit = (fn: (list: Note[]) => Note[]): Promise<void> => {
    const step = chain.then(async () => {
      const raw = (await deps.area.get([NOTES_KEY]))[NOTES_KEY];
      const next = prune(fn(asNotes(raw)), now());
      if (next.length === 0) await deps.area.remove([NOTES_KEY]);
      else await deps.area.set({ [NOTES_KEY]: next });
    });
    chain = step.catch(() => undefined);
    return step;
  };

  const read = async (): Promise<Note[]> => {
    const raw = (await deps.area.get([NOTES_KEY]))[NOTES_KEY];
    return prune(asNotes(raw), now());
  };

  async function distilNow(item: ContextItem): Promise<Note[]> {
    pending.delete(item.tabId);
    if (item.kind === 'selection') return [];
    const host = hostOf(item.origin);
    const say = (verdict: NoteVerdict, kept?: number): Note[] => {
      deps.onDiag?.(item.tabId, { at: now(), host, verdict, ...(kept === undefined ? {} : { kept }) });
      return [];
    };
    if (deps.pinned && (await deps.pinned())) return say('pinned');
    if (done.get(item.origin) === item.hash) return say('unchanged');
    const passing = passingThrough(item, now());
    if (passing) return say(passing);
    const text = normalizeWhitespace(item.text);
    if (text.length < NOTES_LIMITS.minTextChars) return say('short');
    done.set(item.origin, item.hash);

    const facts = (await fromModel(text, host)) ?? fallbackFacts(item);
    const at = now();
    const written = facts.map((f) => truncate(normalizeWhitespace(f), NOTES_LIMITS.factChars)).filter(Boolean);
    const said = written.filter((f) => !onlyTheLabel(f, item.title, host));
    const notes: Note[] = said
      .slice(0, NOTES_LIMITS.perPage)
      .map((f) => ({ at, origin: item.origin, tabId: item.tabId, title: item.title, text: f }));
    if (notes.length === 0) return say(written.length > 0 ? 'title-only' : 'nothing-actionable');
    // The newest reading of an origin supersedes what it said before, and an
    // identical fact from anywhere else is not repeated.
    await edit((list) => {
      const seen = new Set(notes.map((n) => key(n.text)));
      const kept = list.filter((n) => n.origin !== item.origin && !seen.has(key(n.text)));
      return [...kept, ...notes];
    });
    deps.onDiag?.(item.tabId, { at, host, verdict: 'kept', kept: notes.length });
    return notes;
  }

  async function fromModel(text: string, host: string): Promise<string[] | null> {
    if (!deps.distill) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const facts = await deps.distill(text, host, controller.signal);
      return Array.isArray(facts) && facts.length > 0 ? facts : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    onCapture(item, leaving = false) {
      if (item.kind === 'selection') return;
      pending.set(item.tabId, item);
      if (leaving) void distilNow(item).catch(() => undefined);
    },
    async onTabHidden(tabId) {
      const item = pending.get(tabId);
      if (item) await distilNow(item).catch(() => undefined);
    },
    distilNow,
    async top(requester, at = now()) {
      const list = await read();
      const mine = requester.tabId;
      const newestFirst = [...list].sort((a, b) => b.at - a.at);
      const others = newestFirst.filter((n) => n.tabId !== mine);
      const own = mine === undefined ? [] : newestFirst.filter((n) => n.tabId === mine);
      return capOld([...others, ...own], at)
        .slice(0, NOTES_LIMITS.top)
        .map((n) => render(n, at, n.tabId === mine));
    },
    async newest(n, at = now()) {
      const list = await read();
      return [...list]
        .sort((a, b) => b.at - a.at)
        .slice(0, n)
        .map((note) => render(note, at, false));
    },
    sweep: () => edit((list) => list),
    clear() {
      const step = chain.then(() => deps.area.remove([NOTES_KEY]));
      chain = step.catch(() => undefined);
      done.clear();
      pending.clear();
      return step;
    },
    flush: () => chain.then(() => undefined),
  };
}

/** What a page calls itself while it is on its way somewhere else. */
const TRANSIENT_TITLE = /^\s*(redirecting|loading|please wait|one moment|just a moment)\b/i;

/** The hops a browser makes in and out of a login, which are never worth remembering. */
const AUTH_PATH = /(^|\/)(oauth2?|auth|authorize|authenticate|login|log-in|signin|sign-in|signup|sign-up|sso|saml|callback|redirect|logout|log-out)(\/|$)/i;

/**
 * Whether the user passed through this page rather than read it, and which of
 * the four ways it was. A redirect, a login hop, a two-second glance and a
 * page with a title and no body all produce the same thing if they are let
 * through: a note made of the page's title, which then turns up as a value in
 * a search box somewhere else entirely. `undefined` means the page was read.
 */
export function passingThrough(item: Pick<ContextItem, 'title' | 'path' | 'origin' | 'capturedAt'>, at: number): NoteVerdict | undefined {
  if (at - item.capturedAt < NOTES_LIMITS.minDwellMs) return 'glanced';
  if (TRANSIENT_TITLE.test(item.title) || onlyASiteName(item.title, hostOf(item.origin))) return 'transient';
  if (AUTH_PATH.test(item.path)) return 'auth-page';
  return undefined;
}

/** A title that is the site and nothing else: "Reddit", "reddit.com", or nothing at all. */
function onlyASiteName(title: string, host: string): boolean {
  const t = key(title);
  if (t === '') return true;
  const domain = registrableDomain(host);
  return t === key(host) || t === key(domain) || t === key(domainLabel(domain));
}

/**
 * A "fact" that says no more than the page's own title or host. The distiller
 * hands one back when there was nothing on the page to distil, and it reads
 * exactly like a fact until it is offered as a value.
 */
function onlyTheLabel(fact: string, title: string, host: string): boolean {
  const f = key(fact);
  if (f === '') return true;
  const t = key(title);
  return f === t || (t !== '' && t.includes(f)) || f === key(host) || f === key(registrableDomain(host));
}

/**
 * Without a model: the regex candidates already extracted for fills, written
 * out as short facts. Enough for the Maps and Calendar steps offline.
 */
export function fallbackFacts(item: Pick<ContextItem, 'id' | 'text' | 'kind' | 'title'>): string[] {
  const where = item.title ? ` (on "${truncate(item.title, 60)}")` : '';
  return candidatesFrom({ id: item.id, text: item.text, kind: item.kind }, true)
    .slice(0, NOTES_LIMITS.perPage)
    .map((c) => `${CANDIDATE_FACT[c.kind]} mentioned: ${c.value}${where}`);
}

/**
 * Half an hour of reading is a lot of notes, and an hour-old one about
 * somewhere the user has long since left is what the model reaches for when
 * the page in front of it gives it nothing. Two of them are kept, in case the
 * plan really was made this morning; the rest go. Newest first is the order
 * they arrive in, so the two kept are the two newest old ones.
 */
function capOld(ordered: Note[], at: number): Note[] {
  let old = 0;
  return ordered.filter((n) => at - n.at < NOTES_LIMITS.oldMs || ++old <= NOTES_LIMITS.oldMax);
}

/**
 * How old, then the fact, then where it was read. The age leads because it is
 * what the model is asked to weigh the note by, and a line it has to read to
 * the end to date is a line it dates last.
 */
function render(note: Note, at: number, own: boolean): string {
  const where = own ? 'this tab' : `read on ${hostOf(note.origin)}`;
  return `${relativeAge(note.at, at)}: ${note.text} (${where})`;
}

function prune(list: Note[], at: number): Note[] {
  const live = list.filter((n) => at - n.at < NOTES_LIMITS.ttlMs);
  const seen = new Set<string>();
  const deduped: Note[] = [];
  // Newest wins a duplicate, so the list is walked backwards and turned round again.
  for (let i = live.length - 1; i >= 0; i--) {
    const note = live[i]!;
    const k = key(note.text);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(note);
  }
  return deduped.reverse().slice(-NOTES_LIMITS.max);
}

function key(text: string): string {
  return normalizeWhitespace(text).toLowerCase().replace(/[.,;:!?'"()]/g, '');
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function asNotes(v: unknown): Note[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is Note => !!n && typeof n === 'object' && typeof (n as Note).at === 'number' && typeof (n as Note).text === 'string');
}
