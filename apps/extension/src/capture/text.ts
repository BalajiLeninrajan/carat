import { LIMITS, normalizeWhitespace, truncate } from '@carat/shared';
import { isVisible } from './visibility';

const SKIP = 'script,style,noscript,template,svg,[aria-hidden="true"]';
// Priority order: a page-level region beats a log beats an article card.
const PREFERRED = ['main,[role="main"]', '[role="log"]', 'article'];

/**
 * Visible body text without the title/host header, viewport-intersecting
 * text first, whitespace collapsed, clipped to `cap` chars.
 */
export function collectVisibleText(
  doc: Document,
  win: Window | null = doc.defaultView,
  cap: number = LIMITS.pageTextChars,
): string {
  if (!win || !doc.body) return '';
  const preferred = preferredRoot(doc, win);
  if (preferred) {
    const text = collectFrom(preferred, win, cap);
    // Maps keeps stale, empty `role=main` panels around; fall back to the body rather than capture nothing.
    if (text) return text;
  }
  return collectFrom(doc.body, win, cap);
}

function collectFrom(root: Element, win: Window, cap: number): string {
  const doc = root.ownerDocument;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const accepted = new Map<Element, boolean>();
  const inView: string[] = [];
  const rest: string[] = [];
  let inViewLen = 0;
  let restLen = 0;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = normalizeWhitespace(node.nodeValue ?? '');
    if (!text) continue;
    const parent = node.parentElement;
    if (!parent || !accept(parent, win, accepted)) continue;

    if (intersectsViewport(parent.getBoundingClientRect(), vw, vh)) {
      inView.push(text);
      inViewLen += text.length + 1;
      // In-view text always ranks first, so once it fills the cap nothing later matters.
      if (inViewLen >= cap) break;
    } else if (restLen < cap) {
      rest.push(text);
      restLen += text.length + 1;
    }
  }

  return truncate(inView.concat(rest).join(' '), cap);
}

/** Page text for a `page` context item: `title · host` header plus visible body text. */
export function captureVisibleText(doc: Document, win: Window | null = doc.defaultView): string {
  const cap = LIMITS.pageTextChars;
  const header = [normalizeWhitespace(doc.title), doc.location?.host ?? '']
    .filter(Boolean)
    .join(' · ');
  const body = collectVisibleText(doc, win, cap);
  return truncate(header ? `${header}\n${body}` : body, cap);
}

/** First visible preferred region, by selector priority then DOM order. */
function preferredRoot(doc: Document, win: Window): Element | null {
  for (const selector of PREFERRED) {
    for (const el of doc.querySelectorAll(selector)) {
      if (!el.closest(SKIP) && isVisible(el, win)) return el;
    }
  }
  return null;
}

function accept(el: Element, win: Window, cache: Map<Element, boolean>): boolean {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  const ok = !el.closest(SKIP) && isVisible(el, win);
  cache.set(el, ok);
  return ok;
}

function intersectsViewport(r: DOMRect, vw: number, vh: number): boolean {
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
}
