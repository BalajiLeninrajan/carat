import type { ElementDescriptor, FieldDescriptor, PageState as SnapshotState } from '@carat/shared';
import { PAGE_SCROLL_DONE, PAGE_SCROLL_NAME, PAGE_SCROLL_ROLE, interactionChipText, isPageScroll, mergeSuggestions } from '@carat/shared';
import type { AcceptKey, Chip } from '../chip';
import { deepActiveElement, isTextEntry } from '../chip/keys';
import type { FillOutcome } from '../fill';
import { performFill, resolveTarget } from '../fill';
import { relativeAge } from '../format/age';
import type { FrameHub, KnownFrame, MergeInput } from '../frames';
import { createFrameHub, mergeElements, mergeFields } from '../frames';
import type { ElementEntry } from '../interact';
import { MAX_ELEMENTS_BYTES, enumerateElements, performInteraction, stillFits } from '../interact';
import type { InteractionView, NavigationView, RefineResponse, SuggestionSource, SuggestionView } from '../messaging';
import { documentHeight, hasMoreBelow, inViewport, scrollPageDown, scrollToTarget } from '../scroll';
import type { FieldEntry } from '../snapshot';
import { enumerateFields, pageStateOf, valueOf } from '../snapshot';
import type { ScriptContext } from './context';
import { debounce } from './context';
import { pageMeta } from './page-meta';
import type { PageState } from './page-state';
import { send } from './send';

export const SNAPSHOT_TIMING = {
  initialMs: 800,
  debounceMs: 400,
  identicalMs: 60_000,
} as const;

const FIELD_ROLES = new Set(['textbox', 'combobox', 'searchbox']);

interface LastSnapshot {
  key: string;
  at: number;
  suggestions: SuggestionView[];
  navigation: NavigationView[];
  interactions: InteractionView[];
  /** Fields (`f|id`) and elements (`e|id`) the user accepted or dismissed under this snapshot; a late smart answer leaves them alone. */
  settled: Set<string>;
  /** A chip has been shown under this snapshot. */
  shown: boolean;
}

interface Registries {
  fields: Map<string, FieldEntry>;
  elements: Map<string, ElementEntry>;
}

type Answer = Pick<LastSnapshot, 'suggestions' | 'navigation' | 'interactions'>;
const EMPTY: Answer = { suggestions: [], navigation: [], interactions: [] };

/** What a page scroll is settled and suppressed under; it names no element of its own. */
const PAGE_KEY = 'page';

/** The chip on screen right now, enough to put a surer value in the same place. */
type Shown =
  | { kind: 'fill'; id: string; suggestion: SuggestionView; interceptFrom: Element | null }
  | { kind: 'interact'; id: string; suggestion: InteractionView; interceptFrom: Element | null }
  | { kind: 'scroll'; id: string }
  | { kind: 'nav' };

/** What the scroll banner says and does; the chip for the suggestion follows once the page has settled. */
interface ScrollOffer {
  target: Element;
  /** What goes in quotes: the field's label or the element's accessible name. */
  name: string;
  detail?: string;
  reason?: string;
  interceptFrom: Element | null;
  /** Show the chip for the same suggestion; `from` is what had focus when Tab was pressed. */
  then: (from: Element | null) => void;
  /** Esc, or typing, on the banner: drop the suggestion for this page load, telling nobody. */
  forget: () => void;
}

interface PresentOptions {
  /** Keep the chip on this field or element rather than picking afresh; used when only its value changes. */
  prefer?: string;
  interceptFrom?: Element | null;
}

export interface SuggestionsHandle {
  /** The page's own text changed; ask again unless a chip is already up. */
  refresh(): void;
  /** The user pressed the shortcut: ask again right now, past the local memo, the answer cache and the dismissed filter. */
  force(): void;
}

const NO_HANDLE: SuggestionsHandle = { refresh: () => undefined, force: () => undefined };

/** Told when a request leaves and when its answer is in; the status line pulses in between. */
export interface RequestObserver {
  onRequest?(): void;
  onAnswer?(): void;
}

export interface SuggestOptions extends RequestObserver {
  /** Shared with the capture scheduler: the first chip here marks this the page being filled. */
  page?: PageState;
  /** The top frame's hub for cross-origin child frames; built here when not given. */
  hub?: FrameHub;
}

export function startSuggestions(
  ctx: ScriptContext,
  chip: Chip,
  doc: Document = document,
  opts: SuggestOptions = {},
): SuggestionsHandle {
  const maybeWin = doc.defaultView;
  if (!maybeWin) return NO_HANDLE;
  const win: Window = maybeWin;
  const { page } = opts;
  const observer: RequestObserver = opts;

  let last: LastSnapshot | null = null;
  let seq = 0;
  let gen = 0;
  // The field carat just filled keeps focus; the next chip must still take Tab from it.
  let justFilled: Element | null = null;
  let shown: Shown | null = null;
  // Elements already acted on in this page load (`role|name`), plus `scroll` for the page itself; never offered twice.
  const done = new Set<string>();
  // How tall the document was when the last page scroll was accepted: growing past it is new content to offer another.
  let scrolledAtHeight = 0;
  // The descriptors and registries the current answer was presented against, so Esc can move on to the next chip in it.
  let view: { descriptors: FieldDescriptor[]; registries: Registries } | null = null;
  // A ticket is open, so every chip shown from this answer carries the indicator.
  let pending = false;

  /** The ticket is done: the chip's value is final and the status line stops saying "thinking". */
  const settle = (): void => {
    if (!pending) return;
    pending = false;
    chip.settle();
    observer.onAnswer?.();
  };
  // Whether money controls may be described at all; read from the redacted settings before each snapshot.
  let allowPayments = false;
  // Child frames that reported through the protocol, by token, for the current snapshot.
  let frames = new Map<string, KnownFrame>();

  const hub: FrameHub =
    opts.hub ??
    createFrameHub(ctx, doc, {
      onReport: () => snapshotSoon(),
      onKey: (key) => chip.relay(key),
    });

  const locale = (): string | undefined => doc.documentElement.lang || (typeof navigator !== 'undefined' ? navigator.language : undefined) || undefined;

  const snapshot = async (force = false): Promise<void> => {
    if (!ctx.isValid || doc.visibilityState === 'hidden') return;
    // Two short waits before the page is read: the payments setting, and any child frame's fresh report.
    const g = ++gen;
    const settings = await send('getSettings', undefined);
    allowPayments = settings?.allowPayments === true;
    await hub.refresh();
    if (g !== gen || !ctx.isValid) return;
    const merged = hub.frames().map(
      (frame): MergeInput => ({
        frame,
        num: hub.numberOf(frame),
        onScreen: (id) => {
          const rect = hub.anchor(frame, id);
          return !!rect && rect.bottom > 0 && rect.top < win.innerHeight && rect.right > 0 && rect.left < win.innerWidth;
        },
      }),
    );
    frames = new Map(merged.map((m) => [m.frame.token, m.frame] as const));
    // A feed that grew since the last scroll has new content below, so the offer comes back.
    if (done.has(PAGE_SCROLL_DONE) && documentHeight(win, doc) > scrolledAtHeight + win.innerHeight / 2) done.delete(PAGE_SCROLL_DONE);
    const state = pageStateOf(doc, win, [...done]);
    const fields = mergeFields(enumerateFields(doc, win), merged);
    // The page state and the elements share one budget; the lowest-ranked elements go first.
    const maxBytes = MAX_ELEMENTS_BYTES - (state ? JSON.stringify(state).length : 0);
    const elements = mergeElements(enumerateElements(doc, win, { allowPayments, maxBytes }), merged);
    const descriptors = fields.descriptors;
    const registries: Registries = { fields: fields.registry, elements: elements.registry };
    if (descriptors.length === 0 && elements.descriptors.length === 0) {
      chip.hide();
      return;
    }
    const key = snapshotKey(descriptors, elements.descriptors, state);
    const now = Date.now();
    if (!force && last && last.key === key && now - last.at < SNAPSHOT_TIMING.identicalMs) {
      present(last, descriptors, registries);
      return;
    }
    const mine = ++seq;
    observer.onRequest?.();
    const res = await send('suggestRequest', {
      page: pageMeta(doc),
      fields: descriptors,
      ...(elements.descriptors.length > 0 ? { elements: elements.descriptors } : {}),
      ...(state ? { state } : {}),
      ...(force ? { force: true } : {}),
    });
    // A ticket means a better answer may still land, so the status line keeps saying "thinking" until it closes.
    const open = res?.ticket !== undefined && mine === seq && ctx.isValid;
    if (!open) observer.onAnswer?.();
    // A newer snapshot owns the chip now; this answer describes fields that may be gone.
    if (mine !== seq || !ctx.isValid) return;
    const current: LastSnapshot = {
      key,
      at: now,
      suggestions: res?.suggestions ?? [],
      navigation: res?.navigation ?? [],
      interactions: res?.interactions ?? [],
      settled: new Set(),
      shown: false,
    };
    last = current;
    pending = open;
    present(current, descriptors, registries);
    // The smart answer is fetched after the chip is up, never before.
    if (res?.ticket) void refine(res.ticket, current, mine, descriptors, registries);
  };
  const snapshotSoon = debounce(ctx, () => void snapshot(), SNAPSHOT_TIMING.debounceMs);

  /**
   * Fold a later answer in without a visible step backwards. A chip that
   * is up only ever changes value, to something the model was surer of, and
   * never jumps to another field or element; a corner chip is left alone. A
   * chip appears from a smart answer only when the fast one showed nothing at
   * all. A field the user settled stays settled, and anything the user typed
   * meanwhile makes the answer stale. The merged answer is kept either way,
   * so the next Tab or focus can use it.
   */
  async function refine(
    ticket: string,
    snap: LastSnapshot,
    mine: number,
    descriptors: FieldDescriptor[],
    registries: Registries,
  ): Promise<void> {
    // A ticket answers as often as something better lands; `more` says to poll it again.
    for (;;) {
      const res = await send('suggestRefine', { ticket });
      // A newer request owns the indicator and the status line now; leave both to it.
      if (!ctx.isValid || mine !== seq || last !== snap) return;
      fold(res, snap, descriptors, registries);
      if (!res?.more) {
        settle();
        return;
      }
    }
  }

  function fold(res: RefineResponse | undefined, snap: LastSnapshot, descriptors: FieldDescriptor[], registries: Registries): void {
    const fills = (res?.suggestions ?? []).filter((s) => !snap.settled.has(`f|${s.fieldId}`));
    const interactions = (res?.interactions ?? []).filter((s) => !snap.settled.has(`e|${s.elementId}`));
    if (fills.length === 0 && interactions.length === 0) return;
    snap.suggestions = mergeSuggestions(snap.suggestions, fills);
    snap.interactions = mergeSuggestions(snap.interactions, interactions);
    const cur = shown;
    if (chip.visible && cur) {
      // A scroll banner names no value; the chip after the scroll reads the merged answer.
      if (cur.kind === 'fill') {
        const better = snap.suggestions.find((s) => s.fieldId === cur.id);
        if (better && better !== cur.suggestion) {
          presentFill(snap.suggestions, descriptors, registries, { prefer: cur.id, interceptFrom: cur.interceptFrom });
        }
      } else if (cur.kind === 'interact') {
        const better = snap.interactions.find((s) => s.elementId === cur.id);
        if (better && better !== cur.suggestion) {
          presentInteract(snap.interactions, registries.elements, { prefer: cur.id, interceptFrom: cur.interceptFrom });
        }
      }
      return;
    }
    if (!snap.shown && snap.settled.size === 0) present(snap, descriptors, registries);
  }

  // A field chip wins, then a chip on an element; the corner chip only appears when there is nothing on the page to act on.
  function present(answer: Answer, descriptors: FieldDescriptor[], registries: Registries): void {
    view = { descriptors, registries };
    if (presentFill(answer.suggestions, descriptors, registries)) return;
    if (presentInteract(answer.interactions, registries.elements)) return;
    if (presentPageScroll(answer.interactions)) return;
    presentNav(answer.navigation);
  }

  /**
   * After Esc, the next chip from the same answer: the dismissed one is
   * already out of `last`, so this lands on the next field, element or
   * offer, or on nothing. Esc costs one suggestion, never the whole answer.
   */
  function advance(): void {
    if (!last || !view) return;
    present(last, view.descriptors, view.registries);
  }

  /** From here on this is the page being filled: no picture of it, ever. */
  function markFilling(): void {
    if (last) last.shown = true;
    if (page && !page.filling) {
      page.filling = true;
      void send('vision', { action: 'filling', url: doc.location.href, title: doc.title, bodyChars: 0 });
    }
  }

  /** The frame a registry entry lives in, when it is one the hub knows; a frame that has gone quiet cannot perform. */
  function frameOf(entry: { frame?: { token: string } }): KnownFrame | null {
    return entry.frame ? (frames.get(entry.frame.token) ?? null) : null;
  }

  /** Keys for a chip on a frame's field are heard by that frame, not here; tell it which key, and stop telling it once the chip is gone. */
  function armFrame(frame: KnownFrame | null, key: AcceptKey): () => void {
    if (!frame) return () => undefined;
    hub.arm(frame, key);
    return () => hub.disarm();
  }

  function presentFill(
    suggestions: SuggestionView[],
    descriptors: FieldDescriptor[],
    registries: Registries,
    opts: PresentOptions = {},
  ): boolean {
    const registry = registries.fields;
    const byField = new Map(suggestions.map((s) => [s.fieldId, s] as const));
    const pick =
      (opts.prefer !== undefined && byField.has(opts.prefer) ? descriptors.find((d) => d.i === opts.prefer) : undefined) ??
      descriptors.find((d) => d.f === 1 && byField.has(d.i)) ??
      descriptors.find((d) => byField.has(d.i));
    const entry = pick && registry.get(pick.i);
    if (!pick || !entry || !entry.el.isConnected) return false;
    const suggestion = byField.get(pick.i)!;
    const host = doc.location.host;
    const frame = frameOf(entry);
    if (entry.frame && !frame) return false;
    const target = frame ? entry.el : (resolveTarget(host, entry.el, doc.location.pathname) ?? entry.el);
    // The snapshot saw an empty field; the user (or a Maps redirect) may have filled it since.
    if (!frame && valueOf(target)) return false;
    const forget = (): void => {
      if (!last) return;
      last.suggestions = last.suggestions.filter((s) => s !== suggestion);
      last.settled.add(`f|${suggestion.fieldId}`);
    };
    const feedback = (accepted: boolean, outcome?: FillOutcome): void => {
      void send('feedback', {
        fieldId: suggestion.fieldId,
        fingerprint: entry.fingerprint,
        contextId: suggestion.sourceContextId,
        accepted,
        host,
        ...(outcome === 'partial' ? { outcome } : {}),
      });
    };
    const interceptFrom = 'interceptFrom' in opts ? (opts.interceptFrom ?? null) : justFilled;
    const view = {
      ...(suggestion.source ? { detail: describeSource(suggestion.source, host) } : {}),
      ...(suggestion.reason ? { reason: suggestion.reason } : {}),
    };

    const onScreen = frame ? hub.anchor(frame, entry.frame!.remoteId) !== null && inViewport(target, win) : inViewport(target, win);
    if (!onScreen) {
      presentScroll(pick.i, {
        target,
        name: fieldName(pick),
        ...view,
        interceptFrom,
        then: (from) => presentFill(last?.suggestions ?? suggestions, descriptors, registries, { prefer: pick.i, interceptFrom: from }),
        forget,
      });
      return true;
    }

    const disarm = armFrame(frame, 'Tab');
    chip.show({
      target,
      value: suggestion.value,
      ...view,
      pending,
      interceptFrom,
      ...(frame ? { anchor: () => hub.anchor(frame, entry.frame!.remoteId) } : {}),
      async onAccept() {
        disarm();
        justFilled = null;
        const outcome = frame
          ? await hub.perform(frame, { kind: 'fill', id: entry.frame!.remoteId, value: suggestion.value, host, ...(locale() ? { locale: locale()! } : {}) }).then((r) => (r.ok ? (r.outcome ?? 'done') : null))
          : valueOf(target)
            ? null
            : await performFill(target, suggestion.value, host, { ...(locale() ? { locale: locale()! } : {}) });
        if (!ctx.isValid || outcome === null) return;
        // A partial fill leaves the user to finish the field, so their next Tab is theirs; a whole one keeps Tab for the next chip.
        justFilled = outcome === 'done' && !frame ? target : null;
        forget();
        feedback(true, outcome);
        // The answer that named this field usually named the next one too; a
        // fresh round trip would only rediscover it after the user's next Tab.
        present(last ?? EMPTY, descriptors, registries);
        if (!chip.visible) snapshotSoon();
      },
      onDismiss(reason) {
        disarm();
        // A timeout or a vanished target says nothing about the suggestion; Esc and typing over it do.
        if (reason !== 'escape' && reason !== 'typed') return;
        forget();
        feedback(false);
        // Typing means the user is busy in this field; Esc means "not that one", so the next one gets its turn.
        if (reason === 'escape') advance();
      },
    });
    shown = { kind: 'fill', id: pick.i, suggestion, interceptFrom };
    justFilled = null;
    markFilling();
    return true;
  }

  /**
   * One element, one verb, one Tab. The chip sits on the element and reads
   * `Click "Save"?`, or `Open "…" on doordash.com?` for a real link, where it
   * sits on the result's title and Tab clicks the anchor around it. Tab
   * performs it once and asks for a fresh snapshot, since the page usually
   * changes. Nothing is chained onto it. A money control takes Enter instead,
   * and its accept is reported as such.
   */
  function presentInteract(
    interactions: InteractionView[],
    registry: Map<string, ElementEntry>,
    opts: PresentOptions = {},
  ): boolean {
    const fits = (s: InteractionView): boolean => {
      if (isPageScroll(s)) return false;
      const entry = registry.get(s.elementId);
      if (!entry || done.has(entry.key)) return false;
      if (entry.frame) return frameOf(entry) !== null && entry.el.isConnected;
      return stillFits(entry.el, s.verb, entry.role);
    };
    const pick =
      (opts.prefer !== undefined ? interactions.find((s) => s.elementId === opts.prefer && fits(s)) : undefined) ??
      interactions.find(fits);
    const entry = pick && registry.get(pick.elementId);
    if (!pick || !entry) return false;
    const host = doc.location.host;
    const frame = frameOf(entry);
    // A result link is clicked on its anchor but the chip sits on the title inside it.
    const at = entry.at ?? entry.el;
    const text = interactionChipText(pick.verb, entry.name, pick.value, entry.role, entry.site);
    const key: AcceptKey = entry.money ? 'Enter' : 'Tab';
    const forget = (): void => {
      if (!last) return;
      last.interactions = last.interactions.filter((s) => s !== pick);
      last.settled.add(`e|${pick.elementId}`);
    };
    const feedback = (accepted: boolean): void => {
      void send('feedback', {
        kind: 'interact',
        host,
        role: entry.role,
        name: entry.name,
        accepted,
        ...(entry.money && accepted ? { money: true as const } : {}),
      });
    };
    const interceptFrom = 'interceptFrom' in opts ? (opts.interceptFrom ?? null) : justFilled;
    const view = {
      ...(pick.source ? { detail: describeSource(pick.source, host) } : {}),
      ...(pick.reason ? { reason: pick.reason } : {}),
    };
    const accepted = (): void => {
      done.add(entry.key);
      feedback(true);
      snapshotSoon();
    };

    const onScreen = frame ? hub.anchor(frame, entry.frame!.remoteId) !== null && inViewport(at, win) : inViewport(at, win);
    if (!onScreen) {
      presentScroll(pick.elementId, {
        target: at,
        name: entry.name,
        ...view,
        interceptFrom,
        then: (from) => {
          if (pick.verb !== 'scroll') {
            presentInteract(last?.interactions ?? interactions, registry, { prefer: pick.elementId, interceptFrom: from });
            return;
          }
          // A bare scroll was the whole interaction. The element is in view now, which the
          // memoised answer knows nothing about, so the next snapshot asks afresh.
          forget();
          done.add(entry.key);
          feedback(true);
          last = null;
          snapshotSoon();
        },
        forget,
      });
      return true;
    }

    const disarm = armFrame(frame, key);
    chip.show({
      target: at,
      verb: text.verb,
      value: text.value,
      tail: text.tail,
      key,
      ...view,
      pending,
      interceptFrom,
      ...(frame ? { anchor: () => hub.anchor(frame, entry.frame!.remoteId) } : {}),
      async onAccept() {
        disarm();
        justFilled = null;
        forget();
        const ok = frame
          ? (await hub.perform(frame, { kind: 'interact', id: entry.frame!.remoteId, verb: pick.verb, value: pick.value })).ok
          : stillFits(entry.el, pick.verb, entry.role) && performInteraction(entry.el, pick.verb, pick.value, entry.role);
        if (!ctx.isValid || !ok) return;
        accepted();
      },
      onDismiss(reason) {
        disarm();
        if (reason !== 'escape' && reason !== 'typed') return;
        forget();
        feedback(false);
        if (reason === 'escape') advance();
      },
    });
    shown = { kind: 'interact', id: pick.elementId, suggestion: pick, interceptFrom };
    justFilled = null;
    markFilling();
    return true;
  }

  /**
   * `Scroll down? Tab`: the page itself, one viewport, when the page is for
   * reading and nothing above the fold is a better step. It is not a fill, so
   * the page is not marked as being filled; it is an accepted interaction, so
   * it is reported and not offered again until the page grows. Esc suppresses
   * it for this host for ten minutes, like any other chip.
   */
  function presentPageScroll(interactions: InteractionView[]): boolean {
    const pick = interactions.find(isPageScroll);
    if (!pick || done.has(PAGE_SCROLL_DONE) || !hasMoreBelow(win, doc)) return false;
    const host = doc.location.host;
    const forget = (): void => {
      if (!last) return;
      last.interactions = last.interactions.filter((s) => s !== pick);
      last.settled.add(`e|${PAGE_KEY}`);
    };
    const feedback = (accepted: boolean): void => {
      void send('feedback', { kind: 'interact', host, role: PAGE_SCROLL_ROLE, name: PAGE_SCROLL_NAME, accepted });
    };
    chip.showCorner({
      label: 'Scroll down',
      bare: true,
      value: '',
      ...(pick.reason ? { reason: pick.reason } : {}),
      onAccept() {
        forget();
        done.add(PAGE_SCROLL_DONE);
        scrolledAtHeight = documentHeight(win, doc);
        feedback(true);
        void scrollPageDown(win).then(() => {
          if (!ctx.isValid) return;
          // A screen further down is a different question; the memoised answer knows nothing about it.
          last = null;
          snapshotSoon();
        });
      },
      onDismiss(reason) {
        if (reason !== 'escape' && reason !== 'typed') return;
        forget();
        feedback(false);
        if (reason === 'escape') advance();
      },
    });
    shown = { kind: 'scroll', id: PAGE_KEY };
    justFilled = null;
    if (last) last.shown = true;
    return true;
  }

  /**
   * The suggestion's target is scrolled out of view, so the field chip would
   * be invisible. Offer the scroll instead, as a banner: `Scroll to "Add
   * location"? Tab`. Tab brings the element to the middle of the viewport
   * and, once the page has settled, the normal chip for the same suggestion
   * appears, taking Tab from wherever focus was. A scroll is not a fill: it
   * sends no feedback, no filling cue, and consumes nothing. Esc drops the
   * offer for this page load, says nothing to the background, and moves on
   * to the answer's next item.
   */
  function presentScroll(id: string, offer: ScrollOffer): void {
    const { target } = offer;
    chip.showCorner({
      label: 'Scroll to',
      bare: true,
      value: offer.name,
      ...(offer.detail ? { detail: offer.detail } : {}),
      ...(offer.reason ? { reason: offer.reason } : {}),
      pending,
      target,
      interceptFrom: offer.interceptFrom,
      onAccept() {
        const from = deepActiveElement(doc);
        const snap = last;
        void scrollToTarget(target, win).then(() => {
          // A newer answer, or a page that moved on, owns the chip now.
          if (!ctx.isValid || last !== snap || !target.isConnected) return;
          offer.then(from);
        });
      },
      onDismiss(reason) {
        if (reason !== 'escape' && reason !== 'typed') return;
        offer.forget();
        // Declining a scroll is "not that one" as much as Esc on a chip is: the answer's next item gets its turn.
        if (reason === 'escape') advance();
      },
    });
    shown = { kind: 'scroll', id };
    justFilled = null;
    if (last) last.shown = true;
  }

  // A corner chip does not make this the page being filled: it is the source page, and may still be photographed.
  function presentNav(navigation: NavigationView[]): void {
    const nav = navigation[0];
    if (!nav) {
      chip.hide();
      return;
    }
    const forget = (): void => {
      if (last) last.navigation = last.navigation.filter((n) => n !== nav);
    };
    const feedback = (accepted: boolean): void => {
      void send('feedback', { kind: 'nav', intent: nav.intent, value: nav.value, accepted });
    };
    chip.showCorner({
      label: nav.label,
      value: nav.value,
      ...(nav.source ? { detail: describeSource(nav.source, doc.location.host) } : {}),
      ...(nav.reason ? { reason: nav.reason } : {}),
      pending,
      onAccept() {
        forget();
        feedback(true);
        // The background rebuilds the URL from the intent; this message is the user's Tab press and nothing else.
        void send('navigate', nav);
      },
      onDismiss(reason) {
        if (reason !== 'escape' && reason !== 'typed') return;
        forget();
        feedback(false);
        if (reason === 'escape') advance();
      },
    });
    shown = { kind: 'nav' };
    if (last) last.shown = true;
  }

  ctx.setTimeout(() => void snapshot(), SNAPSHOT_TIMING.initialMs);
  ctx.addEventListener(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'visible') snapshotSoon();
  });
  ctx.addEventListener(doc, 'focusin', (e) => {
    if (isField(e.target)) snapshotSoon();
  });
  // Typing while a request is in flight makes its answer stale; drop it rather than chip over the user.
  ctx.addEventListener(doc, 'input', (e) => {
    if (isField(e.target)) seq++;
  });
  ctx.addEventListener(win, 'wxt:locationchange', () => {
    last = null;
    settle();
    done.clear();
    scrolledAtHeight = 0;
    if (page) page.filling = false;
    chip.hide();
    snapshotSoon();
  });
  ctx.onInvalidated(() => {
    chip.destroy();
    hub.destroy();
  });

  return {
    refresh() {
      if (chip.visible) return;
      last = null;
      snapshotSoon();
    },
    force() {
      last = null;
      settle();
      chip.hide();
      void snapshot(true);
    },
  };
}

/** "from discord.com · 2m ago", or "from this page · 2m ago" when the text was read off the page asking. */
function describeSource(source: SuggestionSource, here: string): string {
  const where = source.host === here ? 'this page' : source.host;
  return `from ${where} · ${relativeAge(source.capturedAt)}`;
}

/** What the scroll banner calls a field: its label, aria-label, placeholder or name, whichever the page gave it. */
function fieldName(d: FieldDescriptor): string {
  return d.lb || d.al || d.ph || d.nm || 'the field';
}

function isField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (isTextEntry(target)) return true;
  const role = target.getAttribute('role');
  return role !== null && FIELD_ROLES.has(role);
}

// Focus and how far down the page the user is move without changing what is
// worth suggesting; the kind of page, its query, whether anything is left
// below and what carat already did here all change it.
function snapshotKey(descriptors: FieldDescriptor[], elements: ElementDescriptor[], state: SnapshotState | undefined): string {
  const page = state ? [state.kind, state.q ?? '', state.more, state.done ?? []] : null;
  return JSON.stringify([descriptors.map(({ f: _f, o: _o, ...d }) => d), elements.map(({ o: _o, ...e }) => e), page]);
}
