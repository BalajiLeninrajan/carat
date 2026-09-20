// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCEPT_GLYPH } from '../src/chip/accept-key';
import { clearSurfaces, fromSurface } from '../src/dom/surfaces';
import { Palette } from '../src/engine/content/palette';

let palette: Palette;

/** The overlay's own input, reached the way the page cannot: through the host. */
function boxInput(): HTMLInputElement {
  const host = document.querySelector('carat-palette')!;
  // The root is closed, so the test goes in the same way the class does.
  return (host as HTMLElement & { __root?: ShadowRoot }).__root!.querySelector('.box input')!;
}

beforeEach(() => {
  // A closed root cannot be read from outside, so keep the one the class made.
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    (this as Element & { __root?: ShadowRoot }).__root = root;
    return root;
  });
  palette = new Palette();
});

afterEach(() => {
  palette.destroy();
  document.body.replaceChildren();
  clearSurfaces();
  vi.restoreAllMocks();
});

describe('the instruction box', () => {
  it('is not on the page until it is opened', () => {
    expect(palette.element).toBeNull();
    expect(palette.isOpen).toBe(false);
    palette.open();
    expect(palette.isOpen).toBe(true);
    expect(document.querySelector('carat-palette')).not.toBeNull();
  });

  it('hands the instruction over on Enter and closes itself', () => {
    const onSubmit = vi.fn();
    palette.onSubmit = onSubmit;
    palette.open();
    const input = boxInput();
    input.value = '  book the 9am train  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith('book the 9am train');
    expect(palette.isOpen).toBe(false);
    expect(input.value).toBe('');
  });

  it('asks for nothing when the box is empty', () => {
    const onSubmit = vi.fn();
    palette.onSubmit = onSubmit;
    palette.open();
    boxInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(true);
  });

  it('closes on Escape without running anything', () => {
    const onSubmit = vi.fn();
    palette.onSubmit = onSubmit;
    palette.open();
    boxInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(palette.isOpen).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps what is typed in it away from the page, but lets carat’s key through', () => {
    const heard: string[] = [];
    // Bubble phase, which is where a page's own shortcut handler listens: the
    // overlay stops what it hears before it gets this far.
    document.addEventListener('keydown', (e) => heard.push(e.code || e.key));
    palette.open();
    const input = boxInput();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true, composed: true }));
    expect(heard).toEqual([]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftRight', bubbles: true, composed: true }));
    expect(heard).toEqual(['ShiftRight']);
  });

  it('names the key the confirmation will wait for', () => {
    palette.open();
    const host = document.querySelector('carat-palette') as Element & { __root?: ShadowRoot };
    expect(host.__root!.querySelector('kbd')!.textContent).toBe(ACCEPT_GLYPH);
  });

  it('is one of carat’s own surfaces, so working it is not getting on with the page', () => {
    palette.open();
    const host = document.querySelector('carat-palette')!;
    expect(fromSurface(new Event('pointerdown', { composed: true, bubbles: true }))).toBe(false);
    const inside = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(inside, 'target', { value: host });
    expect(fromSurface(inside)).toBe(true);
  });
});

describe('the task panel', () => {
  it('shows the steps as they land, each with its own state', () => {
    palette.startTask('book the 9am train');
    expect(palette.hasTask).toBe(true);
    palette.step(0, 'Click Departures', 'running', 'the date is set');
    palette.step(1, 'Fill Passenger with "Ada"', 'done');
    expect(palette.steps).toEqual([
      { text: 'Click Departures — the date is set', state: 'running' },
      { text: 'Fill Passenger with "Ada"', state: 'done' },
    ]);
  });

  it('rewrites a step in place rather than adding another line', () => {
    palette.startTask('book the 9am train');
    palette.step(0, 'Click Book', 'running');
    palette.step(0, 'Click Book', 'failed', 'the control is disabled');
    expect(palette.steps).toEqual([{ text: 'Click Book — the control is disabled', state: 'failed' }]);
  });

  it('clears the old steps when a new task starts', () => {
    palette.startTask('one');
    palette.step(0, 'Click Book', 'done');
    palette.startTask('two');
    expect(palette.steps).toEqual([]);
  });

  it('asks a question, and takes the answer back to the task', () => {
    const onAnswer = vi.fn();
    palette.onAnswer = onAnswer;
    palette.startTask('book the 9am train');
    palette.showQuestion('Which station?');
    expect(palette.question).toBe('Which station?');
    const host = document.querySelector('carat-palette') as Element & { __root?: ShadowRoot };
    const ask = host.__root!.querySelector('.ask input') as HTMLInputElement;
    ask.value = 'Waterloo';
    ask.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onAnswer).toHaveBeenCalledWith('Waterloo');
    expect(palette.question).toBeNull();
  });

  it('reads Escape in the question box as a no to that step, not as stopping the task', () => {
    const onQuestionEscape = vi.fn();
    const onStop = vi.fn();
    palette.onQuestionEscape = onQuestionEscape;
    palette.onStop = onStop;
    palette.startTask('book the 9am train');
    palette.showQuestion('Place the order?');
    const host = document.querySelector('carat-palette') as Element & { __root?: ShadowRoot };
    const ask = host.__root!.querySelector('.ask input') as HTMLInputElement;
    ask.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onQuestionEscape).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    expect(palette.question).toBeNull();
  });

  it('says how it ended, and the Stop button asks for that', () => {
    const onStop = vi.fn();
    palette.onStop = onStop;
    palette.startTask('book the 9am train');
    const host = document.querySelector('carat-palette') as Element & { __root?: ShadowRoot };
    (host.__root!.querySelector('.stop') as HTMLButtonElement).click();
    expect(onStop).toHaveBeenCalledTimes(1);
    palette.finish('Stopped.');
    expect(host.__root!.querySelector('.summary')!.textContent).toBe('Stopped.');
    palette.hideTask();
    expect(palette.hasTask).toBe(false);
  });
});
