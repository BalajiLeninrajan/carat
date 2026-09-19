import type { FieldDescriptor } from '@carat/shared';
import type { Chip } from '../chip';
import { isTextEntry } from '../chip/keys';
import { fillElement, resolveTarget } from '../fill';
import { relativeAge } from '../format/age';
import type { NavigationView, SuggestionSource, SuggestionView } from '../messaging';
import type { FieldEntry } from '../snapshot';
import { enumerateFields, valueOf } from '../snapshot';
import type { ScriptContext } from './context';
import { debounce } from './context';
import { pageMeta } from './page-meta';
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
}

export interface SuggestionsHandle {
  /** The page's own text changed; ask again unless a chip is already up. */
  refresh(): void;
  /** The user pressed the shortcut: ask again right now, past the local memo, the answer cache and the dismissed filter. */
  force(): void;
}

const NO_HANDLE: SuggestionsHandle = { refresh: () => undefined, force: () => undefined };

export function startSuggestions(ctx: ScriptContext, chip: Chip, doc: Document = document): SuggestionsHandle {
  const win = doc.defaultView;
  if (!win) return NO_HANDLE;

  let last: LastSnapshot | null = null;
  let seq = 0;
  // The field carat just filled keeps focus; the next chip must still take Tab from it.
  let justFilled: Element | null = null;

  const snapshot = async (force = false): Promise<void> => {
    if (!ctx.isValid || doc.visibilityState === 'hidden') return;
    const { descriptors, registry } = enumerateFields(doc, win);
    if (descriptors.length === 0) {
      chip.hide();
      return;
    }
    const key = snapshotKey(descriptors);
    const now = Date.now();
    if (!force && last && last.key === key && now - last.at < SNAPSHOT_TIMING.identicalMs) {
      present(last, descriptors, registry);
      return;
    }
    const mine = ++seq;
    const res = await send('suggestRequest', {
      page: pageMeta(doc),
      fields: descriptors,
      ...(force ? { force: true } : {}),
    });
    // A newer snapshot owns the chip now; this answer describes fields that may be gone.
    if (mine !== seq || !ctx.isValid) return;
    last = { key, at: now, suggestions: res?.suggestions ?? [], navigation: res?.navigation ?? [] };
    present(last, descriptors, registry);
  };
  const snapshotSoon = debounce(ctx, () => void snapshot(), SNAPSHOT_TIMING.debounceMs);

  // A field chip wins; the corner chip only appears when there is no field to fill.
  function present(answer: Pick<LastSnapshot, 'suggestions' | 'navigation'>, descriptors: FieldDescriptor[], registry: Map<string, FieldEntry>): void {
    if (!presentFill(answer.suggestions, descriptors, registry)) presentNav(answer.navigation);
  }

  function presentFill(suggestions: SuggestionView[], descriptors: FieldDescriptor[], registry: Map<string, FieldEntry>): boolean {
    const byField = new Map(suggestions.map((s) => [s.fieldId, s] as const));
    const pick =
      descriptors.find((d) => d.f === 1 && byField.has(d.i)) ?? descriptors.find((d) => byField.has(d.i));
    const entry = pick && registry.get(pick.i);
    if (!pick || !entry || !entry.el.isConnected) return false;
    const suggestion = byField.get(pick.i)!;
    const host = doc.location.host;
    const target = resolveTarget(host, entry.el, doc.location.pathname) ?? entry.el;
    // The snapshot saw an empty field; the user (or a Maps redirect) may have filled it since.
    if (valueOf(target)) return false;
    const forget = (): void => {
      if (last) last.suggestions = last.suggestions.filter((s) => s !== suggestion);
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

    chip.show({
      target,
      value: suggestion.value,
      ...(suggestion.source ? { detail: describeSource(suggestion.source, doc.location.host) } : {}),
      ...(suggestion.reason ? { reason: suggestion.reason } : {}),
      interceptFrom: justFilled,
      onAccept() {
        justFilled = null;
        if (valueOf(target) || !fillElement(target, suggestion.value, host)) return;
        justFilled = target;
        forget();
        feedback(true);
        // The answer that named this field usually named the next one too; a
        // fresh round trip would only rediscover it after the user's next Tab.
        present(last ?? { suggestions: [], navigation: [] }, descriptors, registry);
        if (!chip.visible) snapshotSoon();
      },
      onDismiss(reason) {
        // A timeout or a vanished target says nothing about the suggestion; Esc and typing over it do.
        if (reason !== 'escape' && reason !== 'typed') return;
        forget();
        feedback(false);
      },
    });
    justFilled = null;
    return true;
  }

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
function snapshotKey(descriptors: FieldDescriptor[]): string {
  return JSON.stringify(descriptors.map(({ f: _f, ...d }) => d));
}
