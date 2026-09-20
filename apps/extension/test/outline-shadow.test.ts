import { beforeEach, describe, expect, it } from 'vitest';
import type { OutlineControl } from '@carat/shared';
import { OUTLINE_LIMITS, buildOutline } from '../src/outline';

const named = (controls: OutlineControl[], name: string): OutlineControl | undefined => controls.find((c) => c.name === name);
const lines = (outline: string): string[] => outline.split('\n');

function attach(host: Element, html: string, mode: ShadowRootMode = 'open'): ShadowRoot {
  const root = host.attachShadow({ mode });
  root.innerHTML = html;
  return root;
}

/** As in outline.test.ts: jsdom lays nothing out, so a test that cares about the fold places its own boxes. */
const VH = window.innerHeight;
const placed = new Map<Element, { top: number; height: number }>();
let scrolled = 0;

function place(el: Element, top: number, height = 40): void {
  placed.set(el, { top, height });
  el.getBoundingClientRect = (): DOMRect => {
    const box = placed.get(el)!;
    return new DOMRect(0, box.top - scrolled, 300, box.height);
  };
}

function pageOf(height: number): void {
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: height, configurable: true });
}

beforeEach(() => {
  document.body.innerHTML = '';
  placed.clear();
  scrolled = 0;
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  pageOf(VH);
});

describe('open shadow roots', () => {
  /** An order card whose insides are a component: the light DOM shows the host and nothing else. */
  const card = (): ShadowRoot => {
    document.body.innerHTML = '<main><h1>Seven Shores Cafe</h1><x-order id="card"></x-order></main>';
    return attach(
      document.getElementById('card')!,
      `<form aria-label="Order">
         <div id="who">Name for the order</div>
         <input id="name" aria-labelledby="who">
         <button id="add">Add to cart</button>
       </form>`,
    );
  };

  it('numbers a control inside the root and points the registry at the real element', () => {
    const root = card();
    const { outline, controls, registry } = buildOutline(document);

    const field = named(controls, 'Name for the order')!;
    expect(field.role).toBe('textbox');
    expect(outline).toContain(`[${field.n}] textbox "Name for the order"`);
    expect(registry.get(field.n)).toEqual({ el: root.getElementById('name') });

    const add = named(controls, 'Add to cart')!;
    expect(outline).toContain(`[${add.n}] button "Add to cart"`);
    expect(registry.get(add.n)).toEqual({ el: root.getElementById('add') });
  });

  it('describes the root\'s own structure, not just the host', () => {
    card();
    const { outline } = buildOutline(document);
    expect(lines(outline)).toContain('  form "Order":');
    // The div inside the root is the field's label: it names the control
    // rather than standing beside it as a line of prose saying the same words.
    expect(outline).toContain('textbox "Name for the order"');
    expect(outline).not.toContain('text: Name for the order');
  });

  it('resolves aria-labelledby inside the root, where the id lives', () => {
    document.body.innerHTML = '<main><div id="who">Shipping address</div><x-order id="card"></x-order></main>';
    attach(document.getElementById('card')!, '<div id="who">Name for the order</div><input id="name" aria-labelledby="who">');
    const { controls } = buildOutline(document);

    // Both roots have a `#who`; the control is named by its own.
    expect(named(controls, 'Name for the order')).toBeDefined();
    expect(named(controls, 'Shipping address')).toBeUndefined();
  });

  it('names a control by a label inside the root', () => {
    document.body.innerHTML = '<main><x-reply id="widget"></x-reply></main>';
    attach(document.getElementById('widget')!, '<label for="body">Reply body</label><textarea id="body"></textarea>');
    const { controls } = buildOutline(document);
    expect(named(controls, 'Reply body')?.role).toBe('textbox');
  });

  it('reads slotted light DOM in slot order, not in the order it was written', () => {
    document.body.innerHTML = `
      <main><x-order id="card">
        <span slot="hours">Open until 9</span>
        <span slot="title">Seven Shores Cafe</span>
      </x-order></main>
    `;
    attach(document.getElementById('card')!, '<slot name="title"></slot> <slot name="hours"></slot>');
    const { outline } = buildOutline(document);

    expect(outline).toContain('text: Seven Shores Cafe Open until 9');
  });

  it('numbers a slotted control where the slot puts it', () => {
    document.body.innerHTML = '<main><x-panel id="panel"><button id="go">Continue</button></x-panel></main>';
    const root = attach(document.getElementById('panel')!, '<h2>Payment</h2><slot></slot>');
    const { outline, controls, registry } = buildOutline(document);
    const go = named(controls, 'Continue')!;

    expect(outline).toContain('h2 Payment');
    expect(outline.indexOf('h2 Payment')).toBeLessThan(outline.indexOf(`[${go.n}] button "Continue"`));
    expect(registry.get(go.n)).toEqual({ el: document.getElementById('go') });
    expect(root.querySelector('slot')).not.toBeNull();
  });

  it('shows a slot\'s fallback when nothing was slotted into it', () => {
    document.body.innerHTML = '<main><x-panel id="panel"></x-panel></main>';
    attach(document.getElementById('panel')!, '<slot>Nothing to pay</slot>');
    expect(buildOutline(document).outline).toContain('Nothing to pay');
  });

  it('leaves out what was slotted into a slot the root hides', () => {
    document.body.innerHTML = '<main><x-panel id="panel"><span>Draft note</span></x-panel></main>';
    attach(document.getElementById('panel')!, '<h2>Payment</h2><slot style="display: none"></slot>');
    const { outline } = buildOutline(document);

    expect(outline).toContain('h2 Payment');
    expect(outline).not.toContain('Draft note');
  });

  it('leaves out light children the root gives no slot to', () => {
    document.body.innerHTML = '<main><x-panel id="panel">Unslotted copy<button>Ghost</button></x-panel></main>';
    attach(document.getElementById('panel')!, '<h2>Payment</h2>');
    const { outline, controls } = buildOutline(document);

    expect(outline).not.toContain('Unslotted copy');
    expect(named(controls, 'Ghost')).toBeUndefined();
  });

  it('counts controls inside a component that sits below the fold', () => {
    document.body.innerHTML = '<main><p id="top">Reading this.</p><x-order id="card"></x-order></main>';
    attach(document.getElementById('card')!, '<button>Add to cart</button>');
    pageOf(VH * 3);
    place(document.getElementById('top')!, 100);
    place(document.getElementById('card')!, VH * 2);
    const { outline, controls } = buildOutline(document);

    expect(named(controls, 'Add to cart')).toBeUndefined();
    expect(lines(outline).at(-1)).toContain('1 control not shown');
  });
});

describe('a closed shadow root', () => {
  it('contributes nothing: carat cannot see in and does not try', () => {
    document.body.innerHTML = '<main><h1>Checkout</h1><x-shut id="shut">Slotted copy</x-shut></main>';
    const root = document.getElementById('shut')!.attachShadow({ mode: 'closed' });
    root.innerHTML = '<p>Card details</p><button>Pay now</button>';
    const { outline, controls } = buildOutline(document);

    expect(outline).toContain('h1 Checkout');
    expect(outline).not.toContain('Card details');
    expect(named(controls, 'Pay now')).toBeUndefined();
    // The host's own light children are all that is left of it.
    expect(outline).toContain('Slotted copy');
  });
});

describe('the depth cap', () => {
  it('stops descending after a fixed number of roots', () => {
    document.body.innerHTML = '<main><x-level id="l1"></x-level></main>';
    let host: Element = document.getElementById('l1')!;
    const levels = OUTLINE_LIMITS.shadowDepth + 4;
    for (let i = 1; i <= levels; i++) {
      const root = attach(host, `<button>Level ${i}</button><x-level id="l${i + 1}"></x-level>`);
      host = root.getElementById(`l${i + 1}`)!;
    }
    const { controls } = buildOutline(document);

    expect(named(controls, 'Level 1')).toBeDefined();
    expect(named(controls, `Level ${OUTLINE_LIMITS.shadowDepth}`)).toBeDefined();
    expect(named(controls, `Level ${OUTLINE_LIMITS.shadowDepth + 1}`)).toBeUndefined();
    expect(controls).toHaveLength(OUTLINE_LIMITS.shadowDepth);
  });
});

describe('a focused control inside a root', () => {
  const widget = (): ShadowRoot => {
    document.body.innerHTML = `
      <main>
        <p id="body">Reading this.</p>
        <x-reply id="widget"></x-reply>
        <footer><a id="away" href="https://example.com/tos">Terms</a></footer>
      </main>
    `;
    const root = attach(
      document.getElementById('widget')!,
      `<form aria-label="Reply">
         <label for="reply">Reply body</label><textarea id="reply"></textarea>
         <button id="send">Send it</button>
       </form>`,
    );
    pageOf(VH * 3);
    place(document.getElementById('body')!, 100);
    place(root.getElementById('reply')!, VH - 60);
    place(root.getElementById('send')!, VH * 2);
    place(document.getElementById('away')!, VH * 2 + 200);
    return root;
  };

  it('marks it FOCUSED and keeps its region whole across the fold', () => {
    const root = widget();

    // Unfocused, the button is as far past the fold as the footer link and goes the same way.
    expect(named(buildOutline(document).controls, 'Send it')).toBeUndefined();

    (root.getElementById('reply') as HTMLTextAreaElement).focus();
    const { outline, controls, focused } = buildOutline(document);
    const reply = named(controls, 'Reply body')!;

    expect(focused).toBe(reply.n);
    expect(outline).toContain(`>> FOCUSED [${reply.n}] textbox "Reply body"`);
    expect(named(controls, 'Send it')).toBeDefined();
    // The exemption belongs to the form in the root, not to the page around it.
    expect(named(controls, 'Terms')).toBeUndefined();
  });
});
