import { frameNumber } from '../frames/protocol';

export interface ChildDocument {
  doc: Document;
  /** The frame element in the enumerating document that holds it (the top-level one, for a nested frame). */
  frame: Element;
  /** The frame's number for `fr`. */
  num: number;
}

/** Same-origin frames are read this many levels down. */
export const CHILD_DEPTH = 2;

/**
 * The documents of same-origin child frames, which the parent reads directly
 * (a cross-origin one reports through the frame protocol instead). A frame
 * whose document is unreachable, empty or still `about:blank` with nothing in
 * it is skipped.
 */
export function childDocuments(doc: Document, depth: number = CHILD_DEPTH): ChildDocument[] {
  const out: ChildDocument[] = [];
  const visit = (parent: Document, top: Element | null, remaining: number): void => {
    if (remaining <= 0) return;
    for (const frame of parent.querySelectorAll('iframe,frame')) {
      const child = reachableDocument(frame);
      if (!child || !child.body) continue;
      const root = top ?? frame;
      out.push({ doc: child, frame: root, num: frameNumber(doc, root) });
      visit(child, root, remaining - 1);
    }
  };
  visit(doc, null, depth);
  return out;
}

function reachableDocument(frame: Element): Document | null {
  try {
    return (frame as HTMLIFrameElement).contentDocument ?? null;
  } catch {
    return null;
  }
}
