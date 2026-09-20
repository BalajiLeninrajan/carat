import type { NextAction } from '@carat/shared';
import type { Chip } from '../chip';
import { performFill } from '../fill';
import type { FrameHub, KnownFrame } from '../frames';
import { createFrameHub } from '../frames';
import { performInteraction, roleOf, stillFits } from '../interact';
import type { OutlineTarget } from '../outline';
import { assembleEvidence } from '../outline';
import { inViewport, scrollPageDown, scrollToTarget } from '../scroll';
import type { ScriptContext } from './context';
import { debounce } from './context';
import type { PageState } from './page-state';
import { send } from './send';

export const SNAPSHOT_TIMING = {
  initialMs: 800,
  debounceMs: 400,
  /** The same outline is not asked about again inside this window. */
  identicalMs: 60_000,
} as const;

export interface ActionsHandle {
  /** The page's own text changed; ask again unless a chip is already up. */
  refresh(): void;
  /** The user pressed the shortcut: ask again right now, past the memo and past the answer cache. */
  force(): void;
}

const NO_HANDLE: ActionsHandle = { refresh: () => undefined, force: () => undefined };

/** Told when a request leaves and when its answer is in; the status line pulses in between. */
export interface RequestObserver {
  onRequest?(): void;
  onAnswer?(): void;
}

export interface ActionOptions extends RequestObserver {
  /** Shared with the capture scheduler: the first chip here marks this the page being acted on. */
  page?: PageState;
  /** The top frame's hub for cross-origin child frames; built here when not given. */
  hub?: FrameHub;
}

/**
 * One chip at a time, for one action. The page is read into an outline, the
 * background answers with the one thing the user is most likely to do next,
 * and Tab does it. A ticket may bring a better answer while the chip is up:
 * the ring moves to the model's control as soon as it names one, and the
 * words change when the action itself lands.
 */
export function startActions(ctx: ScriptContext, chip: Chip, doc: Document = document, opts: ActionOptions = {}): ActionsHandle {
  const maybeWin = doc.defaultView;
  if (!maybeWin || !doc.documentElement) return NO_HANDLE;
  const win: Window = maybeWin;
  const observer: RequestObserver = opts;

  let seq = 0;
  let gen = 0;
  let lastHash = '';
  let lastAt = 0;
  let registry = new Map<number, OutlineTarget>();
  /** What the user has already done here, so the same chip is not offered twice on one page load. */
  const done = new Set<string>();
  /** Esc on a control keeps it quiet for the rest of this page load. */
  const dismissed = new Set<string>();
  let pending = false;

  const hub: FrameHub =
    opts.hub ??
    createFrameHub(ctx, doc, {
      onReport: () => snapshotSoon(),
      onKey: (key) => chip.relay(key),
    });

  const settle = (): void => {
    if (!pending) return;
    pending = false;
    chip.settle();
    observer.onAnswer?.();
  };

  const snapshot = async (force = false): Promise<void> => {
    if (!ctx.isValid || doc.visibilityState === 'hidden') return;
    if (chip.visible && !force) return;
    const g = ++gen;
    await hub.refresh();
    if (g !== gen || !ctx.isValid) return;

    const { request, registry: targets, hash } = assembleEvidence(doc, win, { frames: hub.outlines() });
    if (request.controls.length === 0 && request.outline.trim() === '') {
      chip.hide();
      return;
    }
    const now = Date.now();
    if (!force && hash === lastHash && now - lastAt < SNAPSHOT_TIMING.identicalMs) return;
    lastHash = hash;
    lastAt = now;
    registry = targets;

    const mine = ++seq;
    observer.onRequest?.();
    const res = await send('nextAction', { ...request, ...(force ? { force: true } : {}) });
    if (mine !== seq || !ctx.isValid) return;
    pending = res?.ticket !== undefined;
    if (!pending) observer.onAnswer?.();
    present(res?.action ?? null);
    if (res?.ticket !== undefined) void follow(res.ticket, mine);
  };

  /** The ticket: the ring first, then the action the model settled on. */
  async function follow(ticket: string, mine: number): Promise<void> {
    for (;;) {
      const update = await send('nextActionRefine', { ticket });
      if (!update || mine !== seq || !ctx.isValid) break;
      if (update.target !== undefined) {
        const target = registry.get(update.target)?.el;
        if (target?.isConnected && !chip.visible) chip.ring(target);
      }
      if (update.action !== undefined) present(update.action);
      if (!update.more) break;
    }
    settle();
  }

  function present(action: NextAction | null): void {
    if (!action) {
      if (!chip.visible) chip.hide();
      return;
    }
    const key = actionKey(action);
    if (done.has(key) || dismissed.has(key)) return;
    const target = action.target === null ? undefined : registry.get(action.target);
    if (['fill', 'click', 'select'].includes(action.kind) && !target?.el.isConnected) return;
    if (opts.page) opts.page.filling = true;

    const shared = {
      label: action.label,
      reason: action.reason,
      pending,
      irreversible: action.irreversible,
      onAccept: () => void accept(action, target),
      onDismiss: (why: string) => {
        if (why === 'escape') dismissed.add(key);
        void send('feedback', { kind: action.kind, name: nameOf(action, target), label: action.label, value: action.value, host: doc.location.host, accepted: false });
      },
    };
    // A control the user can see gets the chip on it; everything else is the banner.
    const el = target?.el;
    if (el && inViewport(el, win)) {
      const frame = knownFrame(target);
      chip.show({ ...shared, target: el, ...(frame ? { anchor: () => hub.anchor(frame, String(target!.frame!.remoteId)) } : {}) });
    } else {
      chip.showBanner({ ...shared, ...(el ? { target: el } : {}) });
    }
  }

  async function accept(action: NextAction, target: OutlineTarget | undefined): Promise<void> {
    done.add(actionKey(action));
    const outcome = await perform(action, target);
    void send('feedback', {
      kind: action.kind,
      name: nameOf(action, target),
      label: action.label,
      value: action.value,
      host: doc.location.host,
      accepted: true,
      ...(outcome === 'partial' ? { outcome: 'partial' as const } : {}),
      ...(action.irreversible ? { irreversible: true } : {}),
    });
    // Whatever just happened is the newest thing in the timeline, so ask again.
    snapshotSoon();
  }

  /** Carry the action out. Returns 'partial' when a fill went in but the pick after it did not. */
  async function perform(action: NextAction, target: OutlineTarget | undefined): Promise<'done' | 'partial' | 'failed'> {
    if (action.kind === 'scroll') {
      await scrollPageDown(win);
      return 'done';
    }
    if (action.kind === 'open' || action.kind === 'switch') {
      const res = await send('navigate', { kind: action.kind, value: action.value });
      return res?.ok ? 'done' : 'failed';
    }
    if (!target?.el.isConnected) return 'failed';
    const frame = knownFrame(target);
    if (frame && target.frame) {
      const reply = await hub.perform(frame, {
        kind: 'outline',
        n: Number(target.frame.remoteId),
        action: action.kind === 'fill' ? 'fill' : action.kind === 'select' ? 'select' : 'click',
        value: action.value,
        host: doc.location.host,
      });
      return reply.ok ? (reply.outcome ?? 'done') : 'failed';
    }
    // A control the chip sat on as a banner may be off screen; bring it into view before acting.
    if (!inViewport(target.el, win)) await scrollToTarget(target.el, win);
    if (action.kind === 'fill') {
      const outcome = await performFill(target.el, action.value, doc.location.host, locale() ? { locale: locale()! } : {});
      return outcome ?? 'failed';
    }
    const role = roleOf(target.el) ?? 'button';
    const verb = action.kind === 'select' ? 'choose' : 'click';
    if (!stillFits(target.el, verb, role)) return 'failed';
    return performInteraction(target.el, verb, action.value, role) ? 'done' : 'failed';
  }

  function knownFrame(target: OutlineTarget | undefined): KnownFrame | undefined {
    if (!target?.frame) return undefined;
    return hub.frames().find((f) => f.token === target.frame!.token);
  }

  function locale(): string | undefined {
    return doc.documentElement.lang || (typeof navigator !== 'undefined' ? navigator.language : undefined) || undefined;
  }

  const snapshotSoon = debounce(ctx, () => void snapshot(), SNAPSHOT_TIMING.debounceMs);

  for (const type of ['focusin', 'input', 'click'] as const) {
    ctx.addEventListener(doc, type, snapshotSoon);
  }
  ctx.addEventListener(win, 'scroll', snapshotSoon, { passive: true } as AddEventListenerOptions);
  ctx.addEventListener(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'visible') snapshotSoon();
  });
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(snapshotSoon) : null;
  try {
    mutations?.observe(doc.documentElement, { childList: true, subtree: true });
  } catch {
    mutations?.disconnect();
  }
  ctx.setTimeout(() => void snapshot(), SNAPSHOT_TIMING.initialMs);
  ctx.onInvalidated(() => {
    mutations?.disconnect();
    chip.destroy();
  });

  return {
    refresh: () => snapshotSoon(),
    force: () => {
      lastHash = '';
      dismissed.clear();
      void snapshot(true);
    },
  };
}

/** What counts as the same offer: the kind, the control and the value. */
function actionKey(action: NextAction): string {
  return `${action.kind}|${action.target ?? ''}|${action.value}`;
}

function nameOf(action: NextAction, target: OutlineTarget | undefined): string {
  if (action.kind === 'open' || action.kind === 'switch') return action.value;
  return target?.el.getAttribute('aria-label') ?? action.label;
}
