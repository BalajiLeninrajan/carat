import type { FieldDescriptor, Suggestion } from '@carat/shared';
import type { Chip } from '../chip';
import { isTextEntry } from '../chip/keys';
import { fillElement, resolveTarget } from '../fill';
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
  suggestions: Suggestion[];
}

export function startSuggestions(ctx: ScriptContext, chip: Chip, doc: Document = document): void {
  const win = doc.defaultView;
  if (!win) return;

  let last: LastSnapshot | null = null;
  let seq = 0;
  // The field carat just filled keeps focus; the next chip must still take Tab from it.
  let justFilled: Element | null = null;

  const snapshot = async (): Promise<void> => {
    if (!ctx.isValid || doc.visibilityState === 'hidden') return;
    const { descriptors, registry } = enumerateFields(doc, win);
    if (descriptors.length === 0) {
      chip.hide();
      return;
    }
    const key = snapshotKey(descriptors);
    const now = Date.now();
    if (last && last.key === key && now - last.at < SNAPSHOT_TIMING.identicalMs) {
      present(last.suggestions, descriptors, registry);
      return;
    }
    const mine = ++seq;
    const res = await send('suggestRequest', { page: pageMeta(doc), fields: descriptors });
    // A newer snapshot owns the chip now; this answer describes fields that may be gone.
    if (mine !== seq || !ctx.isValid) return;
    const suggestions = res?.suggestions ?? [];
    last = { key, at: now, suggestions };
    present(suggestions, descriptors, registry);
  };
  const snapshotSoon = debounce(ctx, () => void snapshot(), SNAPSHOT_TIMING.debounceMs);

  function present(
    suggestions: Suggestion[],
    descriptors: FieldDescriptor[],
    registry: Map<string, FieldEntry>,
  ): void {
    const byField = new Map(suggestions.map((s) => [s.fieldId, s] as const));
    const pick =
      descriptors.find((d) => d.f === 1 && byField.has(d.i)) ?? descriptors.find((d) => byField.has(d.i));
    const entry = pick && registry.get(pick.i);
    if (!pick || !entry || !entry.el.isConnected) {
      chip.hide();
      return;
    }
    const suggestion = byField.get(pick.i)!;
    const host = doc.location.host;
    const target = resolveTarget(host, entry.el, doc.location.pathname) ?? entry.el;
    // The snapshot saw an empty field; the user (or a Maps redirect) may have filled it since.
    if (valueOf(target)) {
      chip.hide();
      return;
    }
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
      interceptFrom: justFilled,
      onAccept() {
        justFilled = null;
        if (valueOf(target) || !fillElement(target, suggestion.value, host)) return;
        justFilled = target;
        forget();
        feedback(true);
        // The answer that named this field usually named the next one too; a
        // fresh round trip would only rediscover it after the user's next Tab.
        present(last?.suggestions ?? [], descriptors, registry);
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
