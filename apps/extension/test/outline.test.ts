import { beforeEach, describe, expect, it } from 'vitest';
import type { OutlineControl } from '@carat/shared';
import { OUTLINE_LIMITS, assembleRequest, buildOutline, snapshotHash } from '../src/outline';

/** A Reddit post with its own reply form: landmarks, prose, an in-body link and a focused field. */
const POST = `
  <header>
    <nav><a href="https://www.reddit.com/">Home</a></nav>
  </header>
  <div id="cookie-banner">We use cookies. <button>Accept all</button></div>
  <main>
    <article>
      <h1>The Great Grand River Walk</h1>
      <p>Walked the Grand from Bridgeport down to the dam this morning.</p>
      <p>Has anyone done <a href="https://www.mcmaster.ca/tour">Waterloo to McMaster</a> on foot?</p>
    </article>
    <form aria-label="Reply">
      <label for="body">Reply body</label>
      <textarea id="body"></textarea>
      <select id="flair"><option>Discussion</option><option selected>Question</option></select>
      <button type="submit">Reply</button>
    </form>
  </main>
  <div style="display: none">A draft nobody can see</div>
  <div aria-hidden="true">Screen readers skip this</div>
`;

const lines = (outline: string): string[] => outline.split('\n');
const named = (controls: OutlineControl[], name: string): OutlineControl | undefined => controls.find((c) => c.name === name);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildOutline', () => {
  it('indents landmarks, writes text inline and numbers every control', () => {
    document.body.innerHTML = POST;
    document.getElementById('body')!.focus();
    const { outline, controls, focused } = buildOutline(document);

    expect(lines(outline)).toContain('banner:');
    expect(lines(outline)).toContain('main:');
    expect(lines(outline)).toContain('  form "Reply":');
    expect(lines(outline)).toContain('  h1 The Great Grand River Walk');
    expect(outline).toContain('text: Walked the Grand from Bridgeport down to the dam this morning.');

    // The focused control carries the marker, and `focused` names its number.
    const reply = named(controls, 'Reply body')!;
    expect(focused).toBe(reply.n);
    expect(outline).toContain(`>> FOCUSED [${reply.n}] textbox "Reply body"`);

    expect(named(controls, 'Reply')?.role).toBe('button');
    expect(outline).toContain(`[${named(controls, 'Reply')!.n}] button "Reply"`);
  });

  it('gives an in-body link its number and the host it goes to', () => {
    document.body.innerHTML = POST;
    const { outline, controls } = buildOutline(document);
    const link = named(controls, 'Waterloo to McMaster')!;

    expect(link.role).toBe('link');
    expect(link.host).toBe('mcmaster.ca');
    expect(outline).toContain(`[${link.n}] link "Waterloo to McMaster" -> mcmaster.ca`);
  });

  it('reads a select with its current value and lists its options', () => {
    document.body.innerHTML = POST;
    const { outline, controls } = buildOutline(document);
    const flair = controls.find((c) => c.role === 'select')!;

    expect(flair.value).toBe('Question');
    expect(outline).toContain(`[${flair.n}] select = "Question"`);
    expect(outline).toContain('option "Discussion"');
    expect(outline).toContain('option "Question" (selected)');
  });

  it('leaves out hidden, aria-hidden and cookie-banner content', () => {
    document.body.innerHTML = POST;
    const { outline, controls } = buildOutline(document);

    expect(outline).not.toContain('A draft nobody can see');
    expect(outline).not.toContain('Screen readers skip this');
    expect(outline).not.toContain('We use cookies');
    expect(named(controls, 'Accept all')).toBeUndefined();
  });

  it('never repeats a password value and marks a paying button risky', () => {
    document.body.innerHTML = `
      <form aria-label="Sign in">
        <label for="pw">Password</label><input id="pw" type="password" value="hunter2">
        <button>Place order</button>
        <button>Save</button>
      </form>
    `;
    const { outline, controls } = buildOutline(document);

    expect(outline).not.toContain('hunter2');
    expect(named(controls, 'Password')?.value).toBeUndefined();
    expect(named(controls, 'Place order')?.risky).toBe(true);
    expect(named(controls, 'Save')?.risky).toBeUndefined();
  });

  it('carries required, checked and disabled as the control state', () => {
    document.body.innerHTML = `
      <form aria-label="Order">
        <label for="email">Email</label><input id="email" required>
        <label><input type="checkbox" checked> Keep me posted</label>
        <button disabled>Continue</button>
      </form>
    `;
    const { controls } = buildOutline(document);

    expect(named(controls, 'Email')?.state).toBe('required');
    expect(named(controls, 'Keep me posted')?.state).toBe('checked');
    expect(named(controls, 'Continue')?.state).toBe('disabled');
  });

  describe('the budget', () => {
    const noisy = (paragraphs: number): string => {
      const filler = Array.from({ length: paragraphs }, (_, i) => `<p>Paragraph ${i} ${'padding words '.repeat(20)}</p>`).join('');
      return `
        <main>${filler}</main>
        <form aria-label="Reply"><label for="body">Reply body</label><textarea id="body"></textarea><button>Send it</button></form>
      `;
    };

    it('keeps the focused control and its landmark whole, and says how much it dropped', () => {
      document.body.innerHTML = noisy(60);
      document.getElementById('body')!.focus();
      const { outline, controls, focused } = buildOutline(document, window, { budget: 1200 });

      expect(outline.length).toBeLessThanOrEqual(1200);
      expect(outline).toContain('form "Reply":');
      expect(outline).toContain('>> FOCUSED');
      expect(focused).toBe(named(controls, 'Reply body')!.n);
      expect(outline).toMatch(/\(\d+ lines farther from the focus omitted\)/);
    });

    it('keeps the first line of a region it trimmed, so the model knows it is there', () => {
      document.body.innerHTML = noisy(60);
      document.getElementById('body')!.focus();
      const { outline } = buildOutline(document, window, { budget: 1200 });

      // The region's own line and its first paragraph stay; the ones in between go.
      expect(outline).toContain('main:');
      expect(outline).toContain('Paragraph 0 ');
      expect(outline).not.toContain('Paragraph 30 ');
    });

    it('numbers only the controls it kept', () => {
      document.body.innerHTML = noisy(40);
      const { outline, controls } = buildOutline(document, window, { budget: 900 });
      for (const c of controls) expect(outline).toContain(`[${c.n}]`);
      expect(controls.map((c) => c.n)).toEqual(controls.map((_, i) => i + 1));
    });
  });

  describe('child frames', () => {
    it('walks a same-origin frame and marks its controls with fr', () => {
      document.body.innerHTML = `<main><h1>Checkout</h1><iframe id="card"></iframe></main>`;
      const frame = document.getElementById('card') as HTMLIFrameElement;
      frame.contentDocument!.body.innerHTML = `<label for="num">Card number</label><input id="num">`;
      const { outline, controls } = buildOutline(document);
      const card = named(controls, 'Card number')!;

      expect(outline).toContain('frame:');
      expect(card.fr).toBe(1);
    });

    it('splices a cross-origin frame report in and performs there through the hub', () => {
      document.body.innerHTML = `<main><h1>Checkout</h1><iframe id="pay"></iframe></main>`;
      const frame = document.getElementById('pay')!;
      const reported: OutlineControl[] = [{ n: 1, role: 'textbox', name: 'Card number' }, { n: 2, role: 'button', name: 'Pay now' }];
      const { outline, controls, registry } = buildOutline(document, window, { frames: [{ frame, token: 'abc123', controls: reported }] });

      const pay = named(controls, 'Pay now')!;
      expect(outline).toContain('frame:');
      expect(outline).toContain(`[${pay.n}] button "Pay now"`);
      expect(pay.fr).toBe(1);
      // The backstop flags it even though the frame did not.
      expect(pay.risky).toBe(true);
      expect(registry.get(pay.n)).toEqual({ el: frame, fr: 1, frame: { token: 'abc123', remoteId: '2' } });
    });
  });

  it('hashes the same outline to the same string and a changed one to another', () => {
    document.body.innerHTML = POST;
    const first = buildOutline(document).outline;
    expect(snapshotHash(first)).toBe(snapshotHash(first));
    document.querySelector('h1')!.textContent = 'A different walk';
    expect(snapshotHash(buildOutline(document).outline)).not.toBe(snapshotHash(first));
  });
});

describe('assembleRequest', () => {
  it('describes where the page is, how far down it goes and what it holds', () => {
    document.body.innerHTML = POST;
    document.title = 'The Great Grand River Walk';
    const request = assembleRequest(document, window, { location: { host: 'www.reddit.com', pathname: '/r/waterloo/comments/1' } });

    expect(request.page).toMatchObject({ host: 'www.reddit.com', path: '/r/waterloo/comments/1', title: 'The Great Grand River Walk' });
    expect(request.page.scroll).toEqual({ y: 0, pages: expect.any(Number), more: expect.any(Boolean) });
    expect(request.outline.length).toBeLessThanOrEqual(OUTLINE_LIMITS.budget);
    expect(request.controls.length).toBeGreaterThan(0);
  });
});
