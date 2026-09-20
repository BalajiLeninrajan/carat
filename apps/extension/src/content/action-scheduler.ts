import type { NextAction } from '@carat/shared';
import type { Chip } from '../chip';
import { QUIET_HINT } from '../chip';
import { fromSurface } from '../dom/surfaces';
import { performFill } from '../fill';
import type { FrameHub, KnownFrame } from '../frames';
import { createFrameHub } from '../frames';
import { performInteraction, roleOf, stillFits } from '../interact';
import type { OutlineTarget } from '../outline';
import { assembleEvidence } from '../outline';
import { caratScrollEnd, caratScrolling, inViewport, scrollPageDown, scrollToTarget, viewportsOf } from '../scroll';
import type { ScriptContext } from './context';
import type { PageState } from './page-state';
import { send } from './send';

export const SNAPSHOT_TIMING = {
  /** The first ask goes out at DOMContentLoaded against a smaller outline, so it is cheap and early. */
  firstBudget: 4000,
  /** The page has stopped rewriting itself under us. */
  mutationQuietMs: 400,
  /** How long after carat acted, or after the user did, the page counts as settled. */
  settleMs: 500,
  /**
   * After carat performed an action the question does not wait for the page
   * to settle: it goes out on the next frame, and this is the guard behind
   * that frame for the paint the change lands in.
   */
  afterPerformMs: 16,
  /** No two requests closer together than this, whatever asked for them. */
  minGapMs: 500,
  /**
   * A Tab on a scroll this soon after the last one is the user paging
   * through: the page jumps instead of gliding, so the next chip is not
   * made to wait for the glide.
   */
  repeatScrollMs: 2000,
  /** The same outline, with nothing new in the timeline, is not asked about again inside this window. */
  identicalMs: 60_000,
  /**
   * Esc means "not that". The question goes back out after the first wait
   * with the dismissal in the timeline, then after the second if that answer
   * is refused too, and from the third on at the last wait, for as long as
   * the page is open; the model is never left with nothing to try.
   */
  escRetryMs: [3000, 6000, 10_000],
  /**
   * An exchange that ended with nothing on screen is asked again after this.
   * Long enough that a page mid-render is not asked twice about the same
   * half of itself, short enough that the user is not left looking at a page
   * carat has nothing to say about.
   */
  silentRetryMs: 1200,
  /**
   * Silent asks in a row before carat stops trying. The page that truly has
   * nothing is rare; the loop that would cost a request every second is not.
   * Reset the moment a chip goes up or the user does anything.
   */
  silentRetries: 3,
  /** Refusals in a row before the chip starts saying how to shut carat up. */
  snoozeAfterEscapes: 5,
  /** Shift+Tab: how long this tab hears nothing at all. */
  snoozeMs: 60_000,
} as const;

/**
 * Why a request is going out. They differ in what may stop them: `quiet` and
 * `settled` need the outline to have changed, `force` skips every gate,
 * `performed` skips the memo and the gap both, `retry` follows an Esc, and
 * the rest go through the memo.
 */
type Trigger = 'first' | 'quiet' | 'evidence' | 'focus' | 'performed' | 'settled' | 'user' | 'retry' | 'lost' | 'silent' | 'force';

/** Why an ask did not go out. `snoozed` is the one the user chose. */
type Refusal = 'gone' | 'snoozed' | 'performing' | 'awaiting' | 'queued';

export interface ActionsHandle {
  /** The page's own text changed; ask again unless a chip is already up. */
  refresh(): void;
  /** The user pressed the shortcut: ask again right now, past the memo and past the answer cache. */
  force(): void;
  /** The background wiped what it knew; this page load starts over with nothing. */
  clear(): void;
}

const NO_HANDLE: ActionsHandle = { refresh: () => undefined, force: () => undefined, clear: () => undefined };

/** Told when a request leaves and when its answer is in; the status line pulses in between. */
export interface RequestObserver {
  onRequest?(): void;
  onAnswer?(): void;
  /** A snooze started and will be over at this time, or ended, which is `null`. */
  onQuiet?(until: number | null): void;
  /**
   * Why the scheduler did or did not ask, for the debug panel's timeline:
   * the trigger's own name, with the refusal or the memo as the detail.
   * Nothing reads it unless the panel is open.
   */
  onEvent?(event: { name: string; detail?: string }): void;
}

export interface ActionOptions extends RequestObserver {
  /** Shared with the capture scheduler: the first chip here marks this the page being acted on. */
  page?: PageState;
  /** The top frame's hub for cross-origin child frames; built here when not given. */
  hub?: FrameHub;
}

/**
 * One chip at a time, for one action, and then the next one. The page is read
 * into an outline, the background answers with the one thing the user is most
 * likely to do next, and Tab does it. Carrying an action out is itself a
 * reason to ask again, so a form is filled chip by chip without the user
 * asking for each one.
 *
 * A ticket may bring a better answer while the chip is up: the ring moves to
 * the model's control as soon as it names one, and the words change when the
 * action itself lands.
 */
export function startActions(ctx: ScriptContext, chip: Chip, doc: Document = document, opts: ActionOptions = {}): ActionsHandle {
  const maybeWin = doc.defaultView;
  if (!maybeWin) return NO_HANDLE;
  const win: Window = maybeWin;
  const observer: RequestObserver = opts;

  let seq = 0;
  let gen = 0;
  let registry = new Map<number, OutlineTarget>();
  /** What carat has already done here, so the same chip is not offered twice on one page load. */
  const done = new Set<string>();
  /** Esc on an action keeps it quiet for the rest of this page load. */
  const dismissed = new Set<string>();
  /** The control carat last acted on; the chip after it takes Tab from there too. */
  let lastActed: Element | null = null;
  /** When carat last scrolled the page on a Tab; a Tab soon after jumps instead of gliding. */
  let lastScrollAt = -Infinity;
  let pending = false;

  // The memo: the same outline with nothing new behind it is not asked about twice.
  let lastHash = '';
  let lastAt = 0;
  let lastEvents = -1;
  /** Everything that puts a line in the timeline: the user acting, and carat acting. */
  let events = 0;
  let asked = false;

  // The gate in front of the background: one request at a time, one per gap.
  let inFlight = false;
  let nextTrigger: Trigger | null = null;
  let gapTimer: number | null = null;
  let lastSentAt = 0;
  /** Esc means wait: the next question goes out on the retry timer, or when the user does something. */
  let awaitingUser = false;
  /** How many times Esc has been pressed since the user last did anything; it indexes the backoff. */
  let escapes = 0;
  let retryTimer: number | null = null;
  /** The last dismissal on its way to the timeline; the retry waits for it. */
  let reported: Promise<unknown> = Promise.resolve();
  /** Carat is in the middle of an action; the next question waits for the accept to be reported. */
  let performing = false;
  /** One re-ask per lost ticket, so a worker that keeps dying costs one extra request, not a loop. */
  let lostRetry = false;
  /** Exchanges that ended with no chip on screen, since the last one that did. */
  let silentAsks = 0;
  /** Shift+Tab: when carat may speak on this tab again, or 0 when it may now. */
  let quietUntil = 0;
  let quietTimer: number | null = null;

  const hub: FrameHub =
    opts.hub ??
    createFrameHub(ctx, doc, {
      onReport: () => afterMutation.soon(),
      onKey: (key) => chip.relay(key),
    });

  /** A debounce that can be called off, so a context clear takes its pending asks with it. */
  function settleTimer(ms: number, fn: () => void): { soon(): void; cancel(): void } {
    let id: number | null = null;
    return {
      soon() {
        if (id !== null) clearTimeout(id);
        id = ctx.setTimeout(() => {
          id = null;
          fn();
        }, ms);
      },
      cancel() {
        if (id !== null) clearTimeout(id);
        id = null;
      },
    };
  }

  const afterUser = settleTimer(SNAPSHOT_TIMING.settleMs, () => ask('user'));
  const afterCapture = settleTimer(SNAPSHOT_TIMING.mutationQuietMs, () => ask('evidence'));
  // Behind the fast lane, not in front of it: the page that keeps loading after a click.
  const afterPerform = settleTimer(SNAPSHOT_TIMING.settleMs, () => ask('settled'));
  const afterMutation = settleTimer(SNAPSHOT_TIMING.mutationQuietMs, () => ask('quiet'));
  const afterSilence = settleTimer(SNAPSHOT_TIMING.silentRetryMs, () => ask('silent'));

  /**
   * The exchange is over. A chip on screen is the end of it; nothing on
   * screen is not an answer, so the page is asked again — a bounded few
   * times, because the page that truly has nothing must also be allowed to
   * say so. Everything that could legitimately keep carat quiet is checked
   * first: the snooze, an Esc waiting on its own timer, an action in flight.
   */
  function checkSilent(): void {
    if (!ctx.isValid) return;
    if (chip.visible) {
      silentAsks = 0;
      return;
    }
    if (quietUntil !== 0 || awaitingUser || performing) return;
    if (silentAsks >= SNAPSHOT_TIMING.silentRetries) return;
    silentAsks++;
    afterSilence.soon();
  }

  /** A request the model may still improve on has closed; the chip is final. */
  const settle = (mine: number): void => {
    if (mine !== seq || !pending) return;
    pending = false;
    chip.settle();
    observer.onAnswer?.();
  };

  /**
   * Put a request in. Force beats everything; otherwise one goes out at a
   * time, no closer together than the gap, and the last trigger to arrive
   * while waiting is the one that goes.
   */
  function ask(trigger: Trigger): Refusal | undefined {
    const refusal = decide(trigger);
    observer.onEvent?.({ name: trigger, ...(refusal ? { detail: refusal } : {}) });
    return refusal;
  }

  function decide(trigger: Trigger): Refusal | undefined {
    if (!ctx.isValid) return 'gone';
    // Shift+Tab bought a minute of silence, and nothing buys its way past that:
    // the shortcut ends the snooze itself before it asks.
    if (quietUntil !== 0) return 'snoozed';
    // The focus moving because carat filled a field is not the user moving it.
    if (performing && trigger !== 'force') return 'performing';
    // After Esc, only the user and the retry timer get carat talking again.
    if (awaitingUser && trigger !== 'force' && trigger !== 'user' && trigger !== 'focus' && trigger !== 'retry') return 'awaiting';
    const force = nextTrigger === 'force' || trigger === 'force';
    nextTrigger = force ? 'force' : trigger;
    // The shortcut waits for nothing, and neither does the question after
    // carat acted: repeated Tab is the whole point of that one, so the gap
    // the other triggers sit out does not apply to it.
    const immediate = nextTrigger === 'force' || nextTrigger === 'performed';
    if (immediate && gapTimer !== null) {
      clearTimeout(gapTimer);
      gapTimer = null;
    }
    if (gapTimer !== null || inFlight) return 'queued';
    const wait = immediate ? 0 : SNAPSHOT_TIMING.minGapMs - (Date.now() - lastSentAt);
    if (wait > 0) {
      gapTimer = ctx.setTimeout(() => {
        gapTimer = null;
        run();
      }, wait);
      return 'queued';
    }
    run();
    return undefined;
  }

  function run(): void {
    const trigger = nextTrigger;
    nextTrigger = null;
    if (trigger !== null) void snapshot(trigger);
  }

  /** The flight is over; anything that asked while it was up gets its turn now. */
  function drain(): void {
    const trigger = nextTrigger;
    if (trigger === null) return;
    nextTrigger = null;
    ask(trigger);
  }

  async function snapshot(trigger: Trigger): Promise<void> {
    const force = trigger === 'force';
    if (!ctx.isValid || doc.visibilityState === 'hidden') return;
    if (chip.visible && !force) return;
    inFlight = true;
    try {
      const g = ++gen;
      await hub.refresh();
      if (g !== gen || !ctx.isValid) return;

      const { request, registry: targets, hash } = assembleEvidence(doc, win, {
        frames: hub.outlines(),
        // The first look is a cheaper one, so the chip is up while the page is still arriving.
        ...(asked ? {} : { budget: SNAPSHOT_TIMING.firstBudget }),
      });
      if (request.controls.length === 0 && request.outline.trim() === '') {
        chip.hide();
        return;
      }
      const now = Date.now();
      const fresh = hash !== lastHash;
      // Questions the memo must not answer: a lost ticket, whose whole point
      // is that the last answer never arrived; the one after carat acted,
      // which the timeline has a new line for whatever the outline did; and
      // the one after an exchange that put nothing on screen, whose whole
      // point is that the memo's stored answer was no answer. The settle
      // behind the performed one is not the same question: it is only worth
      // asking if the page moved after the immediate one went out.
      if (!force && trigger !== 'lost' && trigger !== 'performed' && trigger !== 'silent') {
        // A page that settled without changing has nothing new to say.
        if ((trigger === 'quiet' || trigger === 'settled') && !fresh) {
          observer.onEvent?.({ name: 'memo', detail: `${trigger}, the outline has not moved` });
          return;
        }
        if (!fresh && events === lastEvents && now - lastAt < SNAPSHOT_TIMING.identicalMs) {
          observer.onEvent?.({ name: 'memo', detail: `${trigger}, same outline and nothing new in the timeline` });
          return;
        }
      }
      lastHash = hash;
      lastAt = now;
      lastEvents = events;
      lastSentAt = now;
      asked = true;
      registry = targets;

      const mine = ++seq;
      observer.onRequest?.();
      const res = await send('nextAction', { ...request, ...(force ? { force: true } : {}) });
      if (mine !== seq || !ctx.isValid) return;
      pending = res?.ticket !== undefined;
      if (!pending) observer.onAnswer?.();
      present(res?.action ?? null);
      if (res?.ticket !== undefined) void follow(res.ticket, mine);
      // With a ticket the exchange is not over yet; `follow` checks when it is.
      else checkSilent();
    } finally {
      inFlight = false;
      drain();
    }
  }

  /** The ticket: the ring first, then the action the model settled on. */
  async function follow(ticket: string, mine: number): Promise<void> {
    for (;;) {
      const update = await send('nextActionRefine', { ticket });
      if (!update || mine !== seq || !ctx.isValid) break;
      // The service worker went down holding this ticket, so what is on the
      // chip is all the placeholder ever had. Ask once more rather than let
      // it stand as the model's answer.
      if (update.lost) {
        observer.onEvent?.({ name: 'ticket lost', detail: 'the service worker went down holding it' });
        settle(mine);
        // The one re-ask is only spent when it actually goes out: a refusal
        // here (an Esc waiting on its timer, an action in flight) would
        // otherwise burn it and leave the placeholder standing as the answer.
        if (!lostRetry) {
          const refusal = ask('lost');
          if (refusal === undefined || refusal === 'queued') {
            lostRetry = true;
            return;
          }
        }
        // Spent, or refused. A worker that keeps dying must still not end in
        // silence, so what is left is the bounded budget every other path uses.
        checkSilent();
        return;
      }
      // The number lands long before the words do; the ring goes up on it now.
      if (update.target !== undefined) {
        const target = registry.get(update.target)?.el;
        if (target?.isConnected) chip.ring(target);
      }
      if (update.action !== undefined) present(update.action);
      if (!update.more) break;
    }
    lostRetry = false;
    settle(mine);
    if (mine === seq) checkSilent();
  }

  function present(action: NextAction | null): void {
    if (!action) {
      if (!chip.visible) chip.hide();
      return;
    }
    // Taken here, where the offer is made: a scroll's key holds the position
    // it was offered from, not the one the page has moved on to.
    const key = actionKey(action, win, doc);
    if (done.has(key) || dismissed.has(key)) return;
    const target = action.target === null ? undefined : registry.get(action.target);
    if (['fill', 'click', 'select'].includes(action.kind) && !target?.el.isConnected) return;
    // Something is going up; whatever silence came before it is over.
    silentAsks = 0;
    if (opts.page) opts.page.filling = true;

    const el = target?.el;
    const shared = {
      label: action.label,
      reason: action.reason,
      // Said no this often and the user wants the key, not another answer.
      ...(escapes >= SNAPSHOT_TIMING.snoozeAfterEscapes ? { detail: QUIET_HINT } : {}),
      pending,
      irreversible: action.irreversible,
      // The field carat just filled still holds the focus; Tab there is for this chip.
      interceptFrom: lastActed && lastActed !== el ? lastActed : null,
      onAccept: () => void accept(action, target, key),
      onDismiss: (why: string) => onDismiss(why, action, target, key),
    };
    // A control the user can see gets the chip on it; everything else is the banner.
    if (el && inViewport(el, win)) {
      const frame = knownFrame(target);
      chip.show({ ...shared, target: el, ...(frame ? { anchor: () => hub.anchor(frame, String(target!.frame!.remoteId)) } : {}) });
    } else {
      chip.showBanner({ ...shared, ...(el ? { target: el } : {}) });
    }
  }

  /**
   * The chip went away. The user getting on with the page says nothing about
   * the offer, so nothing is reported and nothing is suppressed; Esc and
   * typing over the value do say something. They are a "not that", not a
   * "stop": the question goes back out on the retry timer with the dismissal
   * behind it, and the refused action is never offered again on this page.
   */
  function onDismiss(why: string, action: NextAction, target: OutlineTarget | undefined, key: string): void {
    // Shift+Tab says nothing about this offer, so nothing is reported and
    // nothing is suppressed; it asks for a minute without any offer at all.
    if (why === 'snoozed') {
      snooze();
      return;
    }
    if (why === 'acted' || why === 'scrolled') {
      // Scrolling by hand is the step the scroll banner offered: count it done.
      if (why === 'scrolled' && action.kind === 'scroll') done.add(key);
      userActed();
      afterUser.soon();
      return;
    }
    // The offer ran out of time, or the control under it went away. Neither
    // is the user saying no, and neither leaves anything on screen: ask again
    // rather than let the page stand there with no chip on it.
    if (why === 'timeout' || why === 'detached') {
      checkSilent();
      return;
    }
    if (why !== 'escape' && why !== 'typed') return;
    dismissed.add(key);
    awaitingUser = true;
    // The dismissal is a line in the timeline, so the memo must not swallow what follows it.
    events++;
    reported = send('feedback', { kind: action.kind, name: nameOf(action, target), label: action.label, host: doc.location.host, accepted: false });
    retryAfterDismissal();
  }

  /**
   * Ask again, once the dismissal has reached the timeline, so the model
   * reads it and picks something else. Each refusal buys a longer wait up to
   * the last one, which then repeats: carat keeps trying, just not eagerly.
   */
  function retryAfterDismissal(): void {
    cancelRetry();
    const waits = SNAPSHOT_TIMING.escRetryMs;
    const wait = waits[Math.min(escapes, waits.length - 1)]!;
    escapes++;
    retryTimer = ctx.setTimeout(() => {
      retryTimer = null;
      void reported.then(() => ask('retry'));
    }, wait);
  }

  function cancelRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  /**
   * Shift+Tab. Carat goes quiet on this tab for a minute: every timer that
   * could ask is dropped, the Esc chain with them, and `ask` refuses whatever
   * arrives in the meantime. The minute is the only thing still running.
   */
  function snooze(): void {
    quietUntil = Date.now() + SNAPSHOT_TIMING.snoozeMs;
    nextTrigger = null;
    if (gapTimer !== null) clearTimeout(gapTimer);
    gapTimer = null;
    afterUser.cancel();
    afterCapture.cancel();
    afterPerform.cancel();
    afterMutation.cancel();
    afterSilence.cancel();
    cancelRetry();
    awaitingUser = false;
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = ctx.setTimeout(wake, SNAPSHOT_TIMING.snoozeMs);
    observer.onQuiet?.(quietUntil);
    observer.onEvent?.({ name: 'snooze', detail: `quiet for ${SNAPSHOT_TIMING.snoozeMs / 1000}s` });
    // The model reads this next time: the user wanted silence here, not a better answer.
    events++;
    void send('history', { entries: [{ t: Date.now(), kind: 'snoozed' }] });
  }

  /**
   * The minute is up. The refusals that led here are forgotten, so the hint
   * comes off the next chip, and nothing goes out until something asks for
   * it: the user moving is what starts carat off again, not the clock.
   */
  function wake(): void {
    endSnooze();
    escapes = 0;
  }

  /** The shortcut and a context clear are the two things that cut a snooze short. */
  function endSnooze(): void {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = null;
    if (quietUntil === 0) return;
    quietUntil = 0;
    observer.onQuiet?.(null);
  }

  async function accept(action: NextAction, target: OutlineTarget | undefined, key: string): Promise<void> {
    done.add(key);
    lastActed = target?.el ?? null;
    performing = true;
    try {
      const outcome = await perform(action, target);
      // The timeline has to carry this before the next question goes out, so the accept is awaited.
      await send('feedback', {
        kind: action.kind,
        name: nameOf(action, target),
        label: action.label,
        host: doc.location.host,
        accepted: true,
        ...(outcome === 'partial' ? { outcome: 'partial' as const } : {}),
        ...(action.irreversible ? { irreversible: true } : {}),
      });
    } finally {
      performing = false;
    }
    userActed();
    // Whatever just happened is the newest thing in the timeline. Ask as soon
    // as the DOM carries it, and leave the settle watcher behind that for a
    // page that goes on loading once the immediate question has gone out.
    askPerformed();
    afterPerform.soon();
  }

  /**
   * The fast lane. The page has what carat just did by the next frame, so the
   * question goes out then, with the short guard behind it for the paint. A
   * scroll is the exception: the page is still moving under carat's own
   * scroll, and the outline read before it stops is the one already asked
   * about, so that one waits for the mark to come off instead.
   */
  function askPerformed(): void {
    const g = gen;
    const go = (): void => {
      if (ctx.isValid && g === gen) ask('performed');
    };
    if (caratScrolling()) {
      void caratScrollEnd().then(go);
      return;
    }
    onFrame(() => ctx.setTimeout(go, SNAPSHOT_TIMING.afterPerformMs));
  }

  /** The next frame, or the next task where there are no frames to wait for. */
  function onFrame(fn: () => void): void {
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(() => fn());
    else ctx.setTimeout(fn, 0);
  }

  /**
   * Something new for the timeline, and carat is free to talk again. The
   * retry timer is the user's to interrupt: they are about to bring a
   * question of their own, so the one Esc queued is dropped and the backoff
   * starts over.
   */
  function userActed(): void {
    events++;
    awaitingUser = false;
    escapes = 0;
    silentAsks = 0;
    cancelRetry();
  }

  /** Whether this scroll follows another of carat's closely enough to be the user paging through. */
  function repeating(): boolean {
    const now = Date.now();
    const soon = now - lastScrollAt < SNAPSHOT_TIMING.repeatScrollMs;
    lastScrollAt = now;
    return soon;
  }

  /** Carry the action out. Returns 'partial' when a fill went in but the pick after it did not. */
  async function perform(action: NextAction, target: OutlineTarget | undefined): Promise<'done' | 'partial' | 'failed'> {
    if (action.kind === 'scroll') {
      await scrollPageDown(win, { instant: repeating() });
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
    if (!inViewport(target.el, win)) await scrollToTarget(target.el, win, { instant: repeating() });
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

  /** Everything this page load knew goes: the chip, the memo, what was accepted and what was refused. */
  function clear(): void {
    gen++;
    seq++;
    inFlight = false;
    nextTrigger = null;
    if (gapTimer !== null) clearTimeout(gapTimer);
    gapTimer = null;
    afterUser.cancel();
    afterPerform.cancel();
    afterMutation.cancel();
    afterCapture.cancel();
    afterSilence.cancel();
    cancelRetry();
    endSnooze();
    escapes = 0;
    pending = false;
    chip.hide();
    done.clear();
    dismissed.clear();
    registry = new Map();
    lastActed = null;
    lastHash = '';
    lastAt = 0;
    lastEvents = -1;
    events = 0;
    awaitingUser = false;
    performing = false;
    lostRetry = false;
    silentAsks = 0;
    // Nothing goes out on the spot, but this page load now knows nothing at
    // all, so it is owed a chip again: one ask once the page has settled.
    afterUser.soon();
  }

  const onUser = (e?: Event): void => {
    // Working the debug panel is not working the page.
    if (e && fromSurface(e)) return;
    userActed();
    afterUser.soon();
  };
  // A click, a keystroke or a scroll of the user's own: ask again once they pause.
  for (const type of ['click', 'input'] as const) ctx.addEventListener(doc, type, onUser);
  // Carat's own smooth scroll fires these too; that one is not the user moving.
  const onScrolled = (e: Event): void => {
    if (caratScrolling()) return;
    onUser(e);
  };
  ctx.addEventListener(win, 'scroll', onScrolled, { passive: true } as AddEventListenerOptions);
  // The focus moving is the strongest signal there is; that one does not wait.
  ctx.addEventListener(doc, 'focusin', (e) => {
    // Clicking into the debug panel moves the focus, but not the user's place on the page.
    if (fromSurface(e)) return;
    userActed();
    ask('focus');
  });
  ctx.addEventListener(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'visible') afterUser.soon();
  });
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(() => afterMutation.soon()) : null;
  mutations?.observe(doc.documentElement, { childList: true, subtree: true });

  // The first ask is early: the outline the page has at DOMContentLoaded is usually the one that matters.
  if (doc.readyState === 'loading') ctx.addEventListener(doc, 'DOMContentLoaded', () => ask('first'));
  else ctx.setTimeout(() => ask('first'), 0);

  ctx.onInvalidated(() => {
    mutations?.disconnect();
    chip.destroy();
  });

  return {
    refresh: () => {
      // Text captured from this page is new evidence even when the outline has not moved.
      events++;
      afterCapture.soon();
    },
    force: () => {
      lastHash = '';
      dismissed.clear();
      awaitingUser = false;
      escapes = 0;
      cancelRetry();
      // The user asking by hand outranks the quiet they asked for a moment ago.
      endSnooze();
      ask('force');
    },
    clear,
  };
}

/**
 * What counts as the same offer: the kind, the control and the value. A
 * scroll has neither of the last two, so what tells one from the next is
 * where the page was when it was offered. Without that every scroll after the
 * first would read as the one already taken, and the page would go quiet
 * after a single Tab.
 */
function actionKey(action: NextAction, win: Window, doc: Document): string {
  if (action.kind === 'scroll') return `scroll|${viewportsOf(win, doc).y}`;
  return `${action.kind}|${action.target ?? ''}|${action.value}`;
}

function nameOf(action: NextAction, target: OutlineTarget | undefined): string {
  if (action.kind === 'open' || action.kind === 'switch') return action.value;
  return target?.el.getAttribute('aria-label') ?? action.label;
}
