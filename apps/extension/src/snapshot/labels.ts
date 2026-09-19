import { normalizeWhitespace } from '@carat/shared';

const HEADINGS = 'h1,h2,h3,h4,h5,h6,legend';
const MAX_CLIMB = 6;
const MAX_SIBLINGS = 12;

/** Label text: `<label for>`, wrapping label, aria-labelledby, aria-describedby, in that order. */
export function labelOf(el: Element, doc: Document): string | undefined {
  const wrapping = el.closest('label');
  return (
    joinedText(explicitLabels(el, doc), el) ??
    joinedText(wrapping ? [wrapping] : [], el) ??
    joinedText(idrefs(el.getAttribute('aria-labelledby'), doc), el) ??
    joinedText(idrefs(el.getAttribute('aria-describedby'), doc), el)
  );
}

/** Nearest preceding heading/legend, else the parent's text minus the field's own. */
export function nearbyText(el: Element): string | undefined {
  let node: Element | null = el;
  for (let depth = 0; node && depth < MAX_CLIMB; depth++, node = node.parentElement) {
    let hops = 0;
    for (let sib = node.previousElementSibling; sib && hops < MAX_SIBLINGS; sib = sib.previousElementSibling, hops++) {
      const heading = sib.matches(HEADINGS) ? sib : lastDescendant(sib, HEADINGS);
      if (heading) {
        const text = normalizeWhitespace(heading.textContent ?? '');
        if (text) return text;
      }
    }
  }
  const parent = el.parentElement;
  return parent ? nonEmpty(textExcluding(parent, el)) : undefined;
}

function explicitLabels(el: Element, doc: Document): Element[] {
  if (!el.id) return [];
  // `label[for=...]` would need CSS.escape, which jsdom lacks; htmlFor is exact anyway.
  return Array.from(doc.querySelectorAll<HTMLLabelElement>('label[for]')).filter(
    (l) => l.htmlFor === el.id,
  );
}

function idrefs(attr: string | null, doc: Document): Element[] {
  if (!attr) return [];
  return attr
    .split(/\s+/)
    .map((id) => doc.getElementById(id))
    .filter((e): e is HTMLElement => e !== null);
}

/** Concatenated text of all sources (aria-labelledby lists several ids), or undefined when empty. */
function joinedText(sources: Element[], own: Element): string | undefined {
  const parts = sources.map((src) =>
    src.contains(own) ? textExcluding(src, own) : normalizeWhitespace(src.textContent ?? ''),
  );
  return nonEmpty(parts.filter(Boolean).join(' '));
}

/** Text of `container` skipping everything inside `excluded` (a wrapping label's own control). */
function textExcluding(container: Element, excluded: Element): string {
  const doc = container.ownerDocument;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (excluded.contains(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.nodeValue ?? '');
  return normalizeWhitespace(parts.join(' '));
}

function lastDescendant(root: Element, selector: string): Element | null {
  const all = root.querySelectorAll(selector);
  return all.length ? all[all.length - 1]! : null;
}

function nonEmpty(text: string): string | undefined {
  return text ? text : undefined;
}
