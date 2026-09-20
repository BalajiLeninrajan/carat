import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhostInput, GhostReply } from '../src/background/ghost';
import type { ScriptContext } from '../src/content';
import { GHOST_TIMING, MIN_ROOM_PX, createGhostView, eligible, ghostField, materiallyChanged, readField, startGhost } from '../src/ghost';

/** Font metrics jsdom has no opinion about; the mirror copies these. */
const STYLE: Record<string, string> = {
  fontFamily: 'Inter, sans-serif',
  fontSize: '16px',
  fontWeight: '500',
  fontStyle: 'normal',
  fontVariant: 'normal',
  letterSpacing: '0.2px',
  wordSpacing: 'normal',
  lineHeight: '24px',
  textIndent: '0px',
  textTransform: 'none',
  textAlign: 'left',
  direction: 'ltr',
  paddingTop: '4px',
  paddingRight: '10px',
  paddingBottom: '4px',
  paddingLeft: '12px',
  borderTopWidth: '1px',
  borderRightWidth: '1px',
  borderBottomWidth: '1px',
  borderLeftWidth: '1px',
};

const live: Array<{ invalidate(): void }> = [];

function fakeCtx(): ScriptContext {
  const listeners: Array<[EventTarget, string, EventListener, unknown]> = [];
  const onInvalid: Array<() => void> = [];
  const ctx = {
    isValid: true,
    setTimeout: (fn: () => void, ms?: number) => window.setTimeout(fn, ms),
    addEventListener(target: EventTarget, type: string, handler: EventListener, options?: unknown) {
      listeners.push([target, type, handler, options]);
      target.addEventListener(type, handler, options as AddEventListenerOptions);
    },
    onInvalidated(cb: () => void) {
      onInvalid.push(cb);
      return () => undefined;
    },
    invalidate() {
      ctx.isValid = false;
      for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options as AddEventListenerOptions);
      onInvalid.forEach((cb) => cb());
    },
  };
  live.push(ctx);
  return ctx as unknown as ScriptContext;
}

function place(el: Element, rect: Partial<DOMRect>): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...rect }) as DOMRect;
}

function fixed(el: Element, prop: 'clientWidth' | 'scrollLeft' | 'scrollTop', value: number): void {
  Object.defineProperty(el, prop, { value, configurable: true });
}

/** An `ask` the test drives: one reply at a time, in order. */
function scripted(replies: GhostReply[]) {
  const asked: GhostInput[] = [];
  let i = 0;
  return {
    asked,
    ask: async (input: GhostInput): Promise<GhostReply> => {
      asked.push(input);
      return replies[Math.min(i++, replies.length - 1)]!;
    },
  };
}

/** Let the pause timer fire and every queued reply land. */
async function settle(): Promise<void> {
  vi.advanceTimersByTime(GHOST_TIMING.pauseMs);
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

function input(value: string, over: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.value = value;
  Object.assign(el, over);
  document.body.append(el);
  el.focus();
  try {
    el.setSelectionRange(value.length, value.length);
  } catch {
    // date, number and checkbox inputs refuse; the tests below only ask whether they qualify.
  }
  place(el, { left: 40, top: 120, width: 300, height: 32 });
  fixed(el, 'clientWidth', 300);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => STYLE as unknown as CSSStyleDeclaration);
});

afterEach(() => {
  for (const ctx of live.splice(0)) ctx.invalidate();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('what may carry a ghost', () => {
  it('reads the caret out of an input, a textarea and an editor', () => {
    const el = input('Dinner at Seven');
    el.setSelectionRange(6, 6);
    expect(readField(ghostField(el)!)).toEqual({ prefix: 'Dinner', suffix: ' at Seven', singleLine: true });

    const area = document.createElement('textarea');
    area.value = 'line one\nline two';
    document.body.append(area);
    area.setSelectionRange(17, 17);
    expect(readField(ghostField(area)!)).toEqual({ prefix: 'line one\nline two', suffix: '', singleLine: false });
  });

  it('refuses a range the user has selected: that is an edit, not a place to write', () => {
    const el = input('Dinner at Seven');
    el.setSelectionRange(0, 6);
    expect(readField(ghostField(el)!)).toBeNull();
  });

  it('is never a password, card or code field', () => {
    for (const el of [
      input('hunter2', { type: 'password' } as Partial<HTMLInputElement>),
      input('4111 1111', { name: 'cardNumber' } as Partial<HTMLInputElement>),
      input('123456', { name: 'otp' } as Partial<HTMLInputElement>),
    ]) {
      expect(eligible(ghostField(el)!, readField(ghostField(el)!)!)).toBe(false);
    }
  });

  it('is never an empty field: there Tab still belongs to the action chip', () => {
    const el = input('   ');
    expect(eligible(ghostField(el)!, readField(ghostField(el)!)!)).toBe(false);
    const typed = input('Dinner');
    expect(eligible(ghostField(typed)!, readField(ghostField(typed)!)!)).toBe(true);
  });

  it('is never a field that holds no free text', () => {
    expect(ghostField(input('2026-09-18', { type: 'date' } as Partial<HTMLInputElement>))).toBeNull();
    expect(ghostField(input('', { type: 'checkbox' } as Partial<HTMLInputElement>))).toBeNull();
    expect(ghostField(document.createElement('div'))).toBeNull();
  });
});

describe('the pause and the answer', () => {
  it('asks after the pause, not before, and draws the first token', async () => {
    const el = input('Dinner at Seven');
    const model = scripted([{ text: ' Shores', more: false }]);
    const ghost = startGhost(fakeCtx(), document, { ask: model.ask, measure: () => 40 });

    ghost.typed();
    vi.advanceTimersByTime(GHOST_TIMING.pauseMs - 1);
    await Promise.resolve();
    expect(model.asked).toHaveLength(0);

    await settle();
    expect(model.asked[0]).toMatchObject({ prefix: 'Dinner at Seven', singleLine: true, outline: '' });
    expect(ghost.visible).toBe(true);
    expect(ghost.text).toBe(' Shores');
    expect(ghost.field).toBe(el);
  });

  it('draws the first token while the rest is still being written', async () => {
    input('Dinner at Seven');
    const drawn: string[] = [];
    const replies: GhostReply[] = [
      { text: ' Shores', more: true },
      { text: ' Shores Cafe', more: true },
      { text: ' Shores Cafe on Friday', more: false },
    ];
    let i = 0;
    const asked: GhostInput[] = [];
    const ghost = startGhost(fakeCtx(), document, {
      measure: () => 40,
      ask: async (req) => {
        asked.push(req);
        const reply = replies[i++]!;
        drawn.push(ghost.text);
        return reply;
      },
    });
    ghost.typed();
    await settle();
    // Each poll carries what the page already has, and each answer is on screen before the next goes out.
    expect(asked.map((a) => a.have)).toEqual([undefined, 7, 12]);
    expect(drawn).toEqual(['', ' Shores', ' Shores Cafe']);
    expect(ghost.text).toBe(' Shores Cafe on Friday');
  });

  it('hands Tab back when the model has nothing to continue', async () => {
    input('Dinner at Seven');
    const idle = vi.fn();
    const ghost = startGhost(fakeCtx(), document, { ask: scripted([{ text: '   ', more: false }]).ask, measure: () => 40, onIdle: idle });
    ghost.typed();
    await settle();
    expect(ghost.visible).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('stays out of a one-line field with no room left in it', async () => {
    input('Dinner at Seven');
    const model = scripted([{ text: ' Shores', more: false }]);
    const ghost = startGhost(fakeCtx(), document, { ask: model.ask, measure: () => 300 - (MIN_ROOM_PX - 1) });
    ghost.typed();
    await settle();
    expect(model.asked).toHaveLength(0);
  });

  it('carries the outline the action path last built', async () => {
    input('Dinner at Seven');
    const model = scripted([{ text: ' Shores', more: false }]);
    const ghost = startGhost(fakeCtx(), document, { ask: model.ask, measure: () => 40 });
    ghost.noteOutline('main:\n  [1] textbox "Message"');
    ghost.typed();
    await settle();
    expect(model.asked[0]!.outline).toBe('main:\n  [1] textbox "Message"');
  });
});

describe('where the grey text is drawn', () => {
  it('mirrors an input: its box, its font, its padding and its sideways scroll', async () => {
    const el = input('Dinner at Seven');
    fixed(el, 'scrollLeft', 18);
    const view = createGhostView(document);
    const ghost = startGhost(fakeCtx(), document, { ask: scripted([{ text: ' Shores', more: false }]).ask, measure: () => 40, view });
    ghost.typed();
    await settle();

    expect(document.querySelector('[data-carat-ghost]')).not.toBeNull();
    expect(view.text).toBe(' Shores');
    expect(view.placement).toMatchObject({ mode: 'mirror', left: 40, top: 120, width: 300, height: 32, scrollLeft: 18, scrollTop: 0 });
    expect(view.placement!.font).toBe('500 16px Inter, sans-serif');
  });

  it('mirrors a textarea, wrapping and scrolled down rather than sideways', async () => {
    const area = document.createElement('textarea');
    area.value = 'line one\nline two';
    document.body.append(area);
    area.focus();
    area.setSelectionRange(17, 17);
    place(area, { left: 10, top: 20, width: 400, height: 120 });
    fixed(area, 'scrollTop', 36);
    const view = createGhostView(document);
    const ghost = startGhost(fakeCtx(), document, { ask: scripted([{ text: '\nline three', more: false }]).ask, measure: () => 40, view });
    ghost.typed();
    await settle();
    expect(view.placement).toMatchObject({ mode: 'mirror', left: 10, top: 20, width: 400, height: 120, scrollTop: 36, scrollLeft: 0 });
  });

  it('takes the grey text away again when the ghost goes', async () => {
    input('Dinner at Seven');
    const view = createGhostView(document);
    const ghost = startGhost(fakeCtx(), document, { ask: scripted([{ text: ' Shores', more: false }]).ask, measure: () => 40, view });
    ghost.typed();
    await settle();
    expect(view.visible).toBe(true);
    ghost.drop();
    expect(view.visible).toBe(false);
    expect(view.placement).toBeNull();
  });

  it('puts nothing into the page\'s own DOM: the field and the body text are untouched', async () => {
    const el = input('Dinner at Seven');
    const ghost = startGhost(fakeCtx(), document, { ask: scripted([{ text: ' Shores', more: false }]).ask, measure: () => 40 });
    ghost.typed();
    await settle();
    expect(el.value).toBe('Dinner at Seven');
    expect(document.body.textContent).toBe('');
  });
});

describe('the keys', () => {
  async function upWith(value = 'Dinner at Seven', text = ' Shores Cafe') {
    const el = input(value);
    const ghost = startGhost(fakeCtx(), document, { ask: scripted([{ text, more: false }]).ask, measure: () => 40 });
    ghost.typed();
    await settle();
    expect(ghost.visible).toBe(true);
    return { el, ghost };
  }

  it('Tab takes it, through the fill path, and fires input so a framework sees it', async () => {
    const { el, ghost } = await upWith();
    const events: string[] = [];
    el.addEventListener('input', (e) => events.push(`input:${(e as InputEvent).inputType ?? ''}`));
    el.addEventListener('change', () => events.push('change'));

    const e = key('Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(el.value).toBe('Dinner at Seven Shores Cafe');
    expect(el.selectionStart).toBe('Dinner at Seven Shores Cafe'.length);
    expect(events).toEqual(['input:insertText', 'change']);
    expect(ghost.visible).toBe(false);
  });

  it('Tab inserts at the caret, not at the end', async () => {
    const el = input('Dinner at  on Friday');
    el.setSelectionRange(10, 10);
    const ghost = startGhost(fakeCtx(), document, { ask: scripted([{ text: 'Seven Shores', more: false }]).ask, measure: () => 40 });
    ghost.typed();
    await settle();
    key('Tab');
    expect(el.value).toBe('Dinner at Seven Shores on Friday');
    expect(el.selectionStart).toBe('Dinner at Seven Shores'.length);
    expect(ghost.visible).toBe(false);
  });

  it('Shift+Tab is not the ghost\'s, so the chip\'s quiet minute still works', async () => {
    const { el, ghost } = await upWith();
    const e = key('Tab', { shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(el.value).toBe('Dinner at Seven');
    expect(ghost.visible).toBe(false);
  });

  it('any other key drops it, and a held modifier does not', async () => {
    const { ghost } = await upWith();
    key('Shift');
    expect(ghost.visible).toBe(true);
    key('ArrowLeft');
    expect(ghost.visible).toBe(false);
  });

  it('Esc drops it and stays out of the field until what is in it has really changed', async () => {
    const el = input('Dinner at Seven');
    const model = scripted([{ text: ' Shores', more: false }]);
    const ghost = startGhost(fakeCtx(), document, { ask: model.ask, measure: () => 40 });
    ghost.typed();
    await settle();
    key('Escape');
    expect(ghost.visible).toBe(false);

    // One more character is the same thought, and they just said no to it.
    el.value = 'Dinner at Sevens';
    el.setSelectionRange(16, 16);
    ghost.typed();
    await settle();
    expect(model.asked).toHaveLength(1);

    // A real amount more is a new one.
    el.value = 'Dinner at Seven Shor';
    el.setSelectionRange(20, 20);
    ghost.typed();
    await settle();
    expect(model.asked).toHaveLength(2);
  });

  it('the focus moving takes the ghost with it', async () => {
    const { ghost } = await upWith();
    ghost.focused();
    expect(ghost.visible).toBe(false);
  });
});

function editor(text: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  el.tabIndex = 0;
  el.textContent = text;
  document.body.append(el);
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  place(el, { left: 8, top: 60, width: 500, height: 80 });
  return el;
}

describe('an editor rather than a native control', () => {
  it('reads the text before the caret and counts as multi-line', () => {
    const el = editor('Dinner at Seven');
    expect(readField(ghostField(el)!)).toEqual({ prefix: 'Dinner at Seven', suffix: '', singleLine: false });
  });

  it('stays out of the middle of one: an accept there would land at the end', () => {
    const el = editor('Dinner at Seven');
    const range = document.createRange();
    range.setStart(el.firstChild!, 6);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const text = readField(ghostField(el)!)!;
    expect(text).toMatchObject({ prefix: 'Dinner', suffix: ' at Seven' });
    expect(eligible(ghostField(el)!, text)).toBe(false);
  });

  it('draws on the caret rather than mirroring the box', async () => {
    editor('Dinner at Seven');
    const view = createGhostView(document);
    const ghost = startGhost(fakeCtx(), document, { ask: scripted([{ text: ' Shores Cafe', more: false }]).ask, measure: () => 40, view });
    ghost.typed();
    await settle();
    expect(view.placement).toMatchObject({ mode: 'caret' });
    expect(view.text).toBe(' Shores Cafe');
  });

  it('Tab inserts through the editing pipeline and fires input', async () => {
    const el = editor('Dinner at Seven');
    const events: string[] = [];
    el.addEventListener('input', (e) => events.push(`input:${(e as InputEvent).inputType ?? ''}`));
    const ghost = startGhost(fakeCtx(), document, { ask: scripted([{ text: ' Shores Cafe', more: false }]).ask, measure: () => 40 });
    ghost.typed();
    await settle();
    expect(ghost.visible).toBe(true);
    key('Tab');
    expect(el.textContent).toBe('Dinner at Seven Shores Cafe');
    expect(events).toEqual(['input:insertText']);
  });
});

describe('when a refusal wears off', () => {
  it('counts an edit to what was there, and enough new characters, and nothing less', () => {
    expect(materiallyChanged('Dinner at Seven', 'Dinner at Seven')).toBe(false);
    expect(materiallyChanged('Dinner at Sevens', 'Dinner at Seven')).toBe(false);
    expect(materiallyChanged('Dinner at Sev', 'Dinner at Seven')).toBe(true);
    expect(materiallyChanged('Dinner at Seven Sho', 'Dinner at Seven')).toBe(true);
    expect(materiallyChanged('Lunch at Seven', 'Dinner at Seven')).toBe(true);
  });
});
