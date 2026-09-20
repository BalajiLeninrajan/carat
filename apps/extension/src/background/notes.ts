import type { ContextItem } from '@carat/shared';
import { LIMITS, looksSecret, normalizeWhitespace, truncate } from '@carat/shared';
import type { CandidateKind } from '@carat/providers';
import { candidatesFrom } from '@carat/providers';
import { relativeAge } from '../format/age';
import type { StorageArea } from '../store/storage-area';
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
  factChars: 200,
  /** One copy, as it is stored. */
  clipboardChars: LIMITS.clipboardTextChars,
  /** How long a copy outranks everything else in `top`. */
  clipboardTopMs: 10 * 60_000,
  /** Text under this is not worth a model call. */
  minTextChars: 120,
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
  /**
   * Set on a note that is text the user copied. Absent on a distilled fact,
   * which is what every note was before the clipboard became one of them.
   */
  kind?: 'clipboard';
}

/**
 * One copy, from the page the user made it on or from the system clipboard.
 * `origin` is that page's origin, or the literal `clipboard` for text copied
 * outside the browser, which has no page behind it.
 */
export interface CopiedText {
  text: string;
  origin: string;
  tabId?: number;
  title?: string;
  at?: number;
}

/** The provider's distiller. The engine side implements it; without one the regex path answers. */
export type Distill = (text: string, host: string, signal: AbortSignal) => Promise<string[]>;

export interface NotesDeps {
  area: StorageArea;
  distill?: Distill;
  /** While the store is pinned nothing new is remembered, as with every other capture. */
  pinned?: () => Promise<boolean>;
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
  /**
   * Remember text the user copied, as a note of its own. No distillation:
   * what they copied is already the fact. Answers with the note, or null when
   * the text was empty, secret-looking or the store is pinned.
   */
  noteCopied(copy: CopiedText): Promise<Note | null>;
  /** The copies still held, newest first. What the popup lists with a "copied" tag. */
  copies(): Promise<Note[]>;
  /**
   * Drop the copies, keeping the distilled facts. With an origin, only the
   * copies made there: turning the system clipboard off drops what it read
   * and leaves what the user copied in the browser, which was never its to
   * take.
   */
  dropCopies(origin?: string): Promise<void>;
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
    if (deps.pinned && (await deps.pinned())) return [];
    if (done.get(item.origin) === item.hash) return [];
    const text = normalizeWhitespace(item.text);
    if (text.length < NOTES_LIMITS.minTextChars) return [];
    done.set(item.origin, item.hash);

    const host = hostOf(item.origin);
    const facts = (await fromModel(text, host)) ?? fallbackFacts(item);
    const at = now();
    const notes: Note[] = facts
      .map((f) => truncate(normalizeWhitespace(f), NOTES_LIMITS.factChars))
      .filter(Boolean)
      .slice(0, NOTES_LIMITS.perPage)
      .map((f) => ({ at, origin: item.origin, tabId: item.tabId, title: item.title, text: f }));
    if (notes.length === 0) return [];
    // The newest reading of an origin supersedes what it said before, and an
    // identical fact from anywhere else is not repeated.
    await edit((list) => {
      const seen = new Set(notes.map((n) => key(n.text)));
      // A copy is not a reading of the page, so a fresh reading does not supersede it.
      const kept = list.filter((n) => (n.kind === 'clipboard' || n.origin !== item.origin) && !seen.has(key(n.text)));
      return [...kept, ...notes];
    });
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

  async function noteCopied(copy: CopiedText): Promise<Note | null> {
    if (deps.pinned && (await deps.pinned())) return null;
    const text = truncate(normalizeWhitespace(copy.text), NOTES_LIMITS.clipboardChars);
    if (!text || looksSecret(text)) return null;
    const note: Note = {
      at: copy.at ?? now(),
      origin: copy.origin,
      tabId: copy.tabId ?? -1,
      title: copy.title ?? '',
      text,
      kind: 'clipboard',
    };
    // One note per distinct text: copying the same thing again moves its clock
    // rather than filling the list with it.
    await edit((list) => [...list.filter((n) => key(n.text) !== key(text)), note]);
    return note;
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
    noteCopied,
    async copies() {
      const list = await read();
      return list.filter((n) => n.kind === 'clipboard').sort((a, b) => b.at - a.at);
    },
    dropCopies: (origin) =>
      edit((list) => list.filter((n) => n.kind !== 'clipboard' || (origin !== undefined && n.origin !== origin))),
    async top(requester, at = now()) {
      const list = await read();
      const mine = requester.tabId;
      const newestFirst = [...list].sort((a, b) => b.at - a.at);
      // A copy made in the last ten minutes is the freshest thing carat has,
      // so it goes first; after that it queues with everything else.
      const fresh = newestFirst.filter((n) => isFreshCopy(n, at));
      const rest = newestFirst.filter((n) => !isFreshCopy(n, at));
      const others = rest.filter((n) => n.tabId !== mine);
      const own = mine === undefined ? [] : rest.filter((n) => n.tabId === mine);
      return [...fresh, ...others, ...own]
        .slice(0, NOTES_LIMITS.top)
        .map((n) => render(n, at, n.kind !== 'clipboard' && n.tabId === mine));
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

function isFreshCopy(note: Note, at: number): boolean {
  return note.kind === 'clipboard' && at - note.at < NOTES_LIMITS.clipboardTopMs;
}

function render(note: Note, at: number, own: boolean): string {
  if (note.kind === 'clipboard') {
    return `copied ${relativeAge(note.at, at)} on ${hostOf(note.origin)}: "${note.text}"`;
  }
  const where = own ? '(this tab' : `(read on ${hostOf(note.origin)}`;
  return `${note.text} ${where}, ${relativeAge(note.at, at)})`;
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
