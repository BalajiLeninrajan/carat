import { beforeEach, describe, expect, it } from 'vitest';
import { FRAME_MAX_LINES, parseOutline } from '../src/frames';
import type { FrameLine } from '../src/frames';
import { buildOutline } from '../src/outline';
import type { FrameOutline } from '../src/outline';

/**
 * What a cross-origin child frame contributes to the page the model reads.
 * jsdom will not give us a cross-origin document, so the child here is a
 * same-origin one built and parsed exactly as the frame agent does before it
 * posts, and handed to the top as a report.
 */

function frameIn(parent: string, id: string, child: string): { frame: HTMLIFrameElement; doc: Document; win: Window } {
  document.body.innerHTML = parent;
  const frame = document.getElementById(id) as HTMLIFrameElement;
  const doc = frame.contentDocument!;
  doc.body.innerHTML = child;
  return { frame, doc, win: frame.contentWindow! };
}

/** The report the agent would post for that child. */
function reportOf(frame: Element, doc: Document, win: Window, over: Partial<FrameOutline> = {}): FrameOutline {
  const built = buildOutline(doc, win);
  const parsed = parseOutline(built.outline, FRAME_MAX_LINES);
  return { frame, token: 'tok', controls: built.controls, lines: parsed.lines, ...over };
}

/** The outline's lines with their indentation stripped, which is all the ordering assertions need. */
const flat = (outline: string): string[] => outline.split('\n').map((l) => l.trim());

const under = (outline: string, label: string): string[] => flat(outline).slice(flat(outline).findIndex((l) => l === label) + 1);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a child frame that is mostly prose', () => {
  const PARENT = `<main><h1>Bridge over the Grand</h1><p>Walked down to the dam at dusk.</p><iframe id="talk"></iframe><button>Share</button></main>`;
  const CHILD = `<h2>12 comments</h2><p>Nice shot of the dam.</p><textarea aria-label="Write a comment"></textarea><button>Post</button>`;

  it('contributes its text and its controls, in order, under a line naming the frame', () => {
    const { frame, doc, win } = frameIn(PARENT, 'talk', CHILD);
    const { outline, controls } = buildOutline(document, window, { frames: [reportOf(frame, doc, win, { host: 'comments.example' })] });

    const lines = under(outline, 'frame comments.example:');
    expect(lines.slice(0, 4)).toEqual([
      'h2 12 comments',
      'text: Nice shot of the dam.',
      '[1] textbox "Write a comment"',
      '[2] button "Post"',
    ]);
    // The page's own prose is still above it, and its own control still below.
    expect(flat(outline).indexOf('text: Walked down to the dam at dusk.')).toBeLessThan(flat(outline).indexOf('frame comments.example:'));
    expect(controls.map((c) => c.name)).toEqual(['Write a comment', 'Post', 'Share']);
  });

  it('numbers the child into the page’s own sequence and registers each number against the frame', () => {
    const { frame, doc, win } = frameIn(PARENT, 'talk', CHILD);
    const { controls, registry } = buildOutline(document, window, { frames: [reportOf(frame, doc, win)] });

    expect(controls.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(controls.map((c) => c.fr)).toEqual([1, 1, undefined]);
    // The child numbered these 1 and 2 for itself; the page calls them 1 and 2 as well, but by its own count.
    expect(registry.get(1)).toEqual({ el: frame, fr: 1, frame: { token: 'tok', remoteId: '1' } });
    expect(registry.get(2)).toEqual({ el: frame, fr: 1, frame: { token: 'tok', remoteId: '2' } });
    expect(registry.get(3)!.el).toBe(document.querySelector('button'));
  });

  it('keeps the numbering contiguous across two frames, each resolving to its own', () => {
    document.body.innerHTML = `<main><iframe id="one"></iframe><button>Share</button><iframe id="two"></iframe></main>`;
    const one = document.getElementById('one') as HTMLIFrameElement;
    const two = document.getElementById('two') as HTMLIFrameElement;
    one.contentDocument!.body.innerHTML = `<p>Seven Shores Cafe, Friday</p><button>Reply</button>`;
    two.contentDocument!.body.innerHTML = `<p>Table for two</p><button>Book</button>`;
    const frames = [
      reportOf(one, one.contentDocument!, one.contentWindow!, { token: 'a', host: 'talk.example' }),
      reportOf(two, two.contentDocument!, two.contentWindow!, { token: 'b', host: 'book.example' }),
    ];
    const { outline, controls, registry } = buildOutline(document, window, { frames });

    expect(controls.map((c) => [c.n, c.name])).toEqual([
      [1, 'Reply'],
      [2, 'Share'],
      [3, 'Book'],
    ]);
    expect(registry.get(1)).toEqual({ el: one, fr: 1, frame: { token: 'a', remoteId: '1' } });
    expect(registry.get(3)).toEqual({ el: two, fr: 2, frame: { token: 'b', remoteId: '1' } });
    expect(flat(outline)).toContain('text: Seven Shores Cafe, Friday');
    expect(flat(outline)).toContain('text: Table for two');
  });

  it('carries the child’s notes about its own fold only when it scrolls on its own', () => {
    const { frame, doc, win } = frameIn(PARENT, 'talk', CHILD);
    const quiet = buildOutline(document, window, { frames: [reportOf(frame, doc, win)] });
    expect(quiet.outline).not.toContain('more screens below');

    const scrolls = buildOutline(document, window, {
      frames: [reportOf(frame, doc, win, { summary: ['(2.4 more screens below; 6 controls not shown)'] })],
    });
    expect(flat(scrolls.outline)).toContain('(2.4 more screens below; 6 controls not shown)');
  });
});

describe('a child frame with nothing to read', () => {
  it('contributes its controls alone, as it did before it sent lines at all', () => {
    const { frame, doc, win } = frameIn(
      `<main><h1>Checkout</h1><iframe id="pay"></iframe></main>`,
      'pay',
      `<input aria-label="Card number"><button>Pay now</button>`,
    );
    const report = reportOf(frame, doc, win, { host: 'stripe.example' });
    expect(report.lines!.every((l) => l.kind === 'control')).toBe(true);

    const { outline, controls } = buildOutline(document, window, { frames: [report] });
    expect(under(outline, 'frame stripe.example:')).toEqual(['[1] textbox "Card number"', '[2] button "Pay now"']);
    expect(controls.find((c) => c.name === 'Pay now')!.risky).toBe(true);
  });

  it('falls back to the controls when a child sends none of its lines', () => {
    document.body.innerHTML = `<main><iframe id="pay"></iframe></main>`;
    const frame = document.getElementById('pay')!;
    const { outline } = buildOutline(document, window, {
      frames: [{ frame, token: 'tok', controls: [{ n: 4, role: 'button', name: 'Pay now' }] }],
    });
    expect(under(outline, 'frame:')).toEqual(['[1] button "Pay now"']);
  });
});

describe('a child frame inside a component', () => {
  it('splices under the frame line where the shadow walk meets it, and numbers past the page’s own controls', () => {
    document.body.innerHTML = `<main><button>Upvote</button><div id="card"></div></main>`;
    const host = document.getElementById('card')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<h2>Booking</h2><iframe></iframe>`;
    const frame = root.querySelector('iframe') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    doc.body.innerHTML = `<p>Table for two, Friday at 6.</p><button>Confirm</button>`;

    const report = reportOf(frame, doc, frame.contentWindow!, { host: 'book.example' });
    const { outline, controls, registry } = buildOutline(document, window, { frames: [report] });

    expect(under(outline, 'frame book.example:').slice(0, 2)).toEqual(['text: Table for two, Friday at 6.', '[2] button "Confirm"']);
    expect(flat(outline).indexOf('h2 Booking')).toBeLessThan(flat(outline).indexOf('frame book.example:'));
    expect(controls.map((c) => c.name)).toEqual(['Upvote', 'Confirm']);
    // The frame is the second frame-shaped thing the hub would number, and the
    // registry sends its control back through the hub rather than clicking here.
    expect(controls[1]!.fr).toBe(1);
    expect(registry.get(2)!.frame).toEqual({ token: 'tok', remoteId: '1' });
    expect(registry.get(2)!.el).toBe(frame);
  });
});

describe('the page’s budget', () => {
  /** A frame of prose in front of one field, on a page with controls of its own. */
  function crowded(): { frames: FrameOutline[] } {
    document.body.innerHTML = `<main><iframe id="post"></iframe><button>Upvote</button><button>Save</button><button>Share</button></main>`;
    const frame = document.getElementById('post') as HTMLIFrameElement;
    const paragraphs = Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i} of the embedded article, which runs on for a while about the river.</p>`).join('');
    frame.contentDocument!.body.innerHTML = `<h2>The Grand at dusk</h2>${paragraphs}<button>Read on</button>`;
    return { frames: [reportOf(frame, frame.contentDocument!, frame.contentWindow!, { host: 'read.example' })] };
  }

  it('gives up the child’s text before any control on the page', () => {
    const { frames } = crowded();
    const whole = buildOutline(document, window, { frames });
    expect(flat(whole.outline).filter((l) => l.startsWith('text: Paragraph'))).toHaveLength(8);

    const tight = buildOutline(document, window, { frames, budget: 220 });
    expect(flat(tight.outline).filter((l) => l.startsWith('text: Paragraph'))).toHaveLength(0);
    expect(tight.controls.map((c) => c.name)).toEqual(['Read on', 'Upvote', 'Save', 'Share']);
    expect(tight.outline).toContain('frame read.example:');
  });
});

describe('reading a rendered outline back into lines', () => {
  const kinds = (lines: FrameLine[]): string[] => lines.map((l) => l.kind);

  it('keeps each line’s kind, depth and number, and sets the notes aside', () => {
    const { lines, summary } = parseOutline(
      [
        '(0.4 screens above)',
        'main:',
        '  h2 12 comments',
        '  text: Nice shot of the dam.',
        '  >> FOCUSED [3] textbox "Write a comment"',
        '  [4] select "Sort"',
        '    option "Newest" (selected)',
        '(3 lines farther from the focus omitted)',
        '(2.4 more screens below; 6 controls not shown)',
      ].join('\n'),
      FRAME_MAX_LINES,
    );

    expect(kinds(lines)).toEqual(['struct', 'heading', 'text', 'control', 'control', 'option']);
    expect(lines.map((l) => l.indent)).toEqual([0, 1, 1, 1, 1, 2]);
    expect(lines.filter((l) => l.kind === 'control').map((l) => (l as { n: number }).n)).toEqual([3, 4]);
    // The count of what the child trimmed is the child's own business; the top keeps its own count.
    expect(summary).toEqual(['(0.4 screens above)', '(2.4 more screens below; 6 controls not shown)']);
  });

  it('stops at the cap it is given', () => {
    const outline = Array.from({ length: 40 }, (_, i) => `text: line ${i}`).join('\n');
    expect(parseOutline(outline, 5).lines).toHaveLength(5);
  });
});
