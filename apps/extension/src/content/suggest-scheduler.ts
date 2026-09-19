import type { ElementDescriptor, FieldDescriptor } from '@carat/shared';
import { interactionChipText, mergeSuggestions } from '@carat/shared';
import type { Chip } from '../chip';
import { isTextEntry } from '../chip/keys';
import { fillElement, resolveTarget } from '../fill';
import { relativeAge } from '../format/age';
import type { ElementEntry } from '../interact';
import { enumerateElements, performInteraction, stillFits } from '../interact';
import type { InteractionView, NavigationView, SuggestionSource, SuggestionView } from '../messaging';
import type { FieldEntry } from '../snapshot';
import { enumerateFields, valueOf } from '../snapshot';
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

/** The chip on screen right now, enough to put a surer value in the same place. */
type Shown =
  | { kind: 'fill'; id: string; suggestion: SuggestionView; interceptFrom: Element | null }
  | { kind: 'interact'; id: string; suggestion: InteractionView; interceptFrom: Element | null }
  | { kind: 'nav' };

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
}

export function startSuggestions(
  ctx: ScriptContext,
  chip: Chip,
  doc: Document = document,
  opts: SuggestOptions = {},
): SuggestionsHandle {
  const win = doc.defaultView;
  if (!win) return NO_HANDLE;
  const { page } = opts;
  const observer: RequestObserver = opts;

  let last: LastSnapshot | null = null;
  let seq = 0;
  // The field carat just filled keeps focus; the next chip must still take Tab from it.
  let justFilled: Element | null = null;
  let shown: Shown | null = null;
  // Elements already acted on in this page load (`role|name`); never offered twice.
  const done = new Set<string>();

  const snapshot = async (force = false): Promise<void> => {
    if (!ctx.isValid || doc.visibilityState === 'hidden') return;
    const fields = enumerateFields(doc, win);
    const elements = enumerateElements(doc, win);
    const descriptors = fields.descriptors;
    const registries: Registries = { fields: fields.registry, elements: elements.registry };
    if (descriptors.length === 0 && elements.descriptors.length === 0) {
      chip.hide();
      return;
    }
    const key = snapshotKey(descriptors, elements.descriptors);
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
      ...(force ? { force: true } : {}),
    });
    // The fast answer is the answer as far as the status line is concerned; the smart pass is silent.
    observer.onAnswer?.();
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
    present(current, descriptors, registries);
    // The smart answer is fetched after the chip is up, never before.
    if (res?.ticket) void refine(res.ticket, current, mine, descriptors, registries);
  };
  const snapshotSoon = debounce(ctx, () => void snapshot(), SNAPSHOT_TIMING.debounceMs);

  /**
   * Fold a late smart answer in without a visible step backwards. A chip that
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
    const res = await send('suggestRefine', { ticket });
    if (!ctx.isValid || mine !== seq || last !== snap) return;
    const fills = (res?.suggestions ?? []).filter((s) => !snap.settled.has(`f|${s.fieldId}`));
    const interactions = (res?.interactions ?? []).filter((s) => !snap.settled.has(`e|${s.elementId}`));
    if (fills.length === 0 && interactions.length === 0) return;
    snap.suggestions = mergeSuggestions(snap.suggestions, fills);
    snap.interactions = mergeSuggestions(snap.interactions, interactions);
    const cur = shown;
    if (chip.visible && cur) {
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
    if (presentFill(answer.suggestions, descriptors, registries)) return;
    if (presentInteract(answer.interactions, registries.elements)) return;
    presentNav(answer.navigation);
  }

  /** From here on this is the page being filled: no picture of it, ever. */
  function markFilling(): void {
    if (last) last.shown = true;
    if (page && !page.filling) {
      page.filling = true;
      void send('vision', { action: 'filling', url: doc.location.href, title: doc.title, bodyChars: 0 });
    }
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
    const target = resolveTarget(host, entry.el, doc.location.pathname) ?? entry.el;
    // The snapshot saw an empty field; the user (or a Maps redirect) may have filled it since.
    if (valueOf(target)) return false;
    const forget = (): void => {
      if (!last) return;
      last.suggestions = last.suggestions.filter((s) => s !== suggestion);
      last.settled.add(`f|${suggestion.fieldId}`);
    };
    const feedback = (accepted: boolean): void => {
      void send('feedback', {
        fieldId: suggestion.fieldId,
        fingerprint: entry.fingerprint,
        contextId: suggestion.sourceContextId,
        accepted,
        host,
      });
    };
    const interceptFrom = 'interceptFrom' in opts ? (opts.interceptFrom ?? null) : justFilled;

    chip.show({
      target,
      value: suggestion.value,
      ...(suggestion.source ? { detail: describeSource(suggestion.source, doc.location.host) } : {}),
      ...(suggestion.reason ? { reason: suggestion.reason } : {}),
      interceptFrom,
      onAccept() {
        justFilled = null;
        if (valueOf(target) || !fillElement(target, suggestion.value, host)) return;
        justFilled = target;
        forget();
        feedback(true);
        // The answer that named this field usually named the next one too; a
        // fresh round trip would only rediscover it after the user's next Tab.
        present(last ?? EMPTY, descriptors, registries);
        if (!chip.visible) snapshotSoon();
      },
      onDismiss(reason) {
        // A timeout or a vanished target says nothing about the suggestion; Esc and typing over it do.
        if (reason !== 'escape' && reason !== 'typed') return;
        forget();
        feedback(false);
      },
    });
    shown = { kind: 'fill', id: pick.i, suggestion, interceptFrom };
    justFilled = null;
    markFilling();
    return true;
  }

  /**
   * One element, one verb, one Tab. The chip sits on the element and reads
   * `Click "Save"?`; Tab performs it once and asks for a fresh snapshot, since
   * the page usually changes. Nothing is chained onto it.
   */
  function presentInteract(
    interactions: InteractionView[],
    registry: Map<string, ElementEntry>,
    opts: PresentOptions = {},
  ): boolean {
    const fits = (s: InteractionView): boolean => {
      const entry = registry.get(s.elementId);
      return !!entry && !done.has(entry.key) && stillFits(entry.el, s.verb);
    };
    const pick =
      (opts.prefer !== undefined ? interactions.find((s) => s.elementId === opts.prefer && fits(s)) : undefined) ??
      interactions.find(fits);
    const entry = pick && registry.get(pick.elementId);
    if (!pick || !entry) return false;
    const host = doc.location.host;
    const text = interactionChipText(pick.verb, entry.name, pick.value);
    const forget = (): void => {
      if (!last) return;
      last.interactions = last.interactions.filter((s) => s !== pick);
      last.settled.add(`e|${pick.elementId}`);
    };
    const feedback = (accepted: boolean): void => {
      void send('feedback', { kind: 'interact', host, role: entry.role, name: entry.name, accepted });
    };
    const interceptFrom = 'interceptFrom' in opts ? (opts.interceptFrom ?? null) : justFilled;

    chip.show({
      target: entry.el,
      verb: text.verb,
      value: text.value,
      tail: text.tail,
      ...(pick.source ? { detail: describeSource(pick.source, host) } : {}),
      ...(pick.reason ? { reason: pick.reason } : {}),
      interceptFrom,
      onAccept() {
        justFilled = null;
        forget();
        if (!stillFits(entry.el, pick.verb) || !performInteraction(entry.el, pick.verb, pick.value)) return;
        done.add(entry.key);
        feedback(true);
        snapshotSoon();
      },
      onDismiss(reason) {
        if (reason !== 'escape' && reason !== 'typed') return;
        forget();
        feedback(false);
      },
    });
    shown = { kind: 'interact', id: pick.elementId, suggestion: pick, interceptFrom };
    justFilled = null;
    markFilling();
    return true;
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
    done.clear();
    if (page) page.filling = false;
    chip.hide();
    snapshotSoon();
  });
  ctx.onInvalidated(() => chip.destroy());

  return {
    refresh() {
      if (chip.visible) return;
      last = null;
      snapshotSoon();
    },
    force() {
      last = null;
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

function isField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (isTextEntry(target)) return true;
  const role = target.getAttribute('role');
  return role !== null && FIELD_ROLES.has(role);
}

// Focus moves without changing what is worth suggesting; the rest of the descriptor does.
function snapshotKey(descriptors: FieldDescriptor[], elements: ElementDescriptor[]): string {
  return JSON.stringify([descriptors.map(({ f: _f, ...d }) => d), elements]);
}
