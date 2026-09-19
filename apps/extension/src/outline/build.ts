import type { ControlRole, OutlineControl } from '@carat/shared';
import { hashText, normalizeWhitespace, registrableDomain, truncate } from '@carat/shared';
import { isVisible } from '../capture/visibility';
import { isSecretField } from '../dom/secret';
import { isIframe, isInput, isSelect, isTextArea } from '../dom/tags';
import type { FrameRef } from '../frames/protocol';
import { frameNumber } from '../frames/protocol';
import { accessibleName } from '../interact';
import { labelOf } from '../snapshot/labels';
import { documentHeight, inViewport, viewportRect } from '../scroll';
import { controlRoleOf, isEditable, isRiskyName, stateOf } from './roles';

export const OUTLINE_LIMITS = {
  /** Characters the outline may take in the request. */
  budget: 9000,
  nameChars: 90,
  valueChars: 120,
  textChars: 240,
  /** Options listed under one select. */
  maxOptions: 12,
  /** Numbered controls; the ones farthest from the focus go first. */
  maxControls: 60,
  /** Same-origin frames are walked this many levels down, as the rest of carat reads them. */
  frameDepth: 2,
  /** How far past the fold still counts as on screen, in viewports. */
  foldMargin: 0.25,
} as const;

/** Never described: they carry no text a reader sees. */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'head', 'link', 'meta',
  'audio', 'video', 'object', 'embed', 'datalist', 'legend', 'caption', 'figcaption',
]);

/** Marked cookie banners, consent walls and ad slots: furniture, never the next step. */
const JUNK = [
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[aria-label*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[id*="onetrust" i]',
  '[class*="onetrust" i]',
  '[id*="gdpr" i]',
  '[class*="gdpr" i]',
  '[data-testid*="cookie" i]',
  '[data-nosnippet][class*="banner" i]',
  'ins.adsbygoogle',
  '[id^="google_ads"]',
  '[data-ad-slot]',
  '[data-ad-client]',
  '[class*="advert" i]',
  '[id*="advert" i]',
  '[aria-label*="advertisement" i]',
].join(',');

const LANDMARK_TAGS: Record<string, string> = {
  header: 'banner',
  nav: 'navigation',
  main: 'main',
  footer: 'contentinfo',
  aside: 'complementary',
  form: 'form',
  dialog: 'dialog',
};
const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'search', 'form', 'dialog', 'alertdialog', 'region']);
const CONTAINER_TAGS: Record<string, string> = {
  section: 'region',
  article: 'article',
  fieldset: 'group',
  table: 'table',
  figure: 'figure',
  ul: 'list',
  ol: 'list',
};
const CONTAINER_ROLES = new Set(['region', 'group', 'radiogroup', 'article', 'tablist', 'tabpanel', 'menu', 'menubar', 'toolbar', 'list', 'table', 'grid', 'figure', 'feed']);
/** Text inside these keeps flowing into the line being built. */
const INLINE_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'code', 'mark', 'time', 'abbr', 'sub', 'sup', 'q', 'cite', 'var', 'kbd', 'samp', 'del', 'ins', 'bdi', 'bdo', 'wbr', 'br', 'font']);
/** A control of one of these roles with no name says nothing; it is left out unless it has the focus. */
const NEEDS_NAME = new Set<ControlRole>(['button', 'link', 'tab', 'menuitem', 'option']);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

type LineKind = 'struct' | 'heading' | 'text' | 'control' | 'option';

interface OutlineLine {
  indent: number;
  kind: LineKind;
  text: string;
  order: number;
  /** Index of the enclosing struct line, or -1 at the top level. */
  region: number;
  keep: boolean;
  focused: boolean;
  /** A struct line for a landmark rather than a plain named container. */
  landmark?: boolean;
  /** Index into `raw` for a control line. */
  control?: number;
}

interface RawControl {
  el: Element;
  role: ControlRole;
  name: string;
  value?: string;
  state?: string;
  host?: string;
  fr?: number;
  frame?: FrameRef;
  risky?: boolean;
}

/** What a cross-origin child frame reported, spliced in where its frame element sits. */
export interface FrameOutline {
  /** The frame element in this document. */
  frame: Element;
  /** The hub's token for the frame; the top performs there by the control's own number. */
  token: string;
  controls: readonly OutlineControl[];
}

export interface OutlineOptions {
  budget?: number;
  /** Reports from cross-origin child frames. Same-origin ones are read directly. */
  frames?: readonly FrameOutline[];
  /** Overrides the document's own focus; tests and the frame agent pass it. */
  focused?: Element | null;
}

/** Where a numbered control lives, for performing it after a Tab. */
export interface OutlineTarget {
  /** The control itself, or the frame element when a child frame performs. */
  el: Element;
  fr?: number;
  frame?: FrameRef;
}

export interface PageOutline {
  outline: string;
  controls: OutlineControl[];
  focused?: number;
  /** n -> what to act on. Not sent anywhere; the content script keeps it. */
  registry: Map<number, OutlineTarget>;
}

interface WalkContext {
  indent: number;
  region: number;
  /** Inside a heading or a control, whose name already carries this text. */
  inNamed: boolean;
  win: Window;
  doc: Document;
  /** The frame number when this document is a same-origin child. */
  fr?: number;
  depth: number;
  /** Inside the focused control's region, which is described past the fold. */
  exempt: boolean;
}

/** The two lines that tell the model what it is not being shown. */
interface ViewportNotes {
  above?: string;
  below?: string;
}

/**
 * The page as text, the way the model reads it: landmarks and headings
 * indented, visible prose as `text:` lines, and every operable control on its
 * own numbered line with its role, name, value and state. The focused control
 * is marked. Script, style, hidden and `aria-hidden` subtrees are left out,
 * and so are marked cookie banners and ad slots. Same-origin child frames are
 * walked directly; a cross-origin one arrives through the frame hub as
 * `opts.frames` and its controls are spliced in where its frame element sits.
 * Both carry `fr`.
 *
 * Only what is on screen is described: a box lying entirely above the fold,
 * entirely below it plus a quarter of a viewport, or off to the side is left
 * out whole, and the controls inside it are neither numbered nor listed in
 * `controls`. An element with no box has no geometry to be judged by and
 * stays. The focused control's own region is described whole even where it
 * crosses the fold. What is missing is said rather than hidden: the outline
 * opens with `(1.5 screens above)` when the page is scrolled and closes with
 * `(3.2 more screens below; 14 controls not shown)`, so the model knows to
 * answer `scroll`.
 *
 * The whole thing is held to `opts.budget` characters: the focused control's
 * own landmark is kept whole and everything else is trimmed by distance from
 * the focus (or from the top of the viewport when nothing has it), page text
 * first, then list options, then controls, then headings. The first line of a
 * trimmed region stays, so the model knows the region is there.
 */
export function buildOutline(doc: Document, win: Window | null = doc.defaultView, opts: OutlineOptions = {}): PageOutline {
  const registry = new Map<number, OutlineTarget>();
  if (!win || !doc.body) return { outline: '', controls: [], registry };

  const budget = opts.budget ?? OUTLINE_LIMITS.budget;
  const lines: OutlineLine[] = [];
  const raw: RawControl[] = [];
  const frames = opts.frames ?? [];
  const focusedEl = opts.focused !== undefined ? opts.focused : deepActiveElement(doc);
  const focusRegion = regionAround(focusedEl);
  let focusedLine = -1;
  let anchorOrder = -1;
  let order = 0;
  /** Controls left out for being off screen, counted for the closing line. */
  let hidden = 0;

  const fold = win.innerHeight * (1 + OUTLINE_LIMITS.foldMargin);
  const offScreen = (el: Element): boolean => {
    let rect: DOMRect;
    try {
      rect = viewportRect(el, win);
    } catch {
      return false;
    }
    // No box means no geometry to judge by; the other filters decide.
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom <= 0 || rect.top >= fold) return true;
    return rect.right <= 0 || rect.left >= win.innerWidth;
  };

  // An ancestor of the focused control is walked into wherever it sits, but
  // only the control's own region carries the exemption down to its children.
  const holdsFocus = (el: Element): boolean =>
    focusedEl !== null && el.ownerDocument === focusedEl.ownerDocument && el.contains(focusedEl);

  // Text between two structural lines is gathered up and emitted as one `text:` line.
  let buffer: string[] = [];
  let bufferAt: { indent: number; region: number } | null = null;

  const push = (kind: LineKind, text: string, ctx: Pick<WalkContext, 'indent' | 'region'>, extra: Partial<OutlineLine> = {}): number => {
    lines.push({ indent: ctx.indent, kind, text, order: order++, region: ctx.region, keep: true, focused: false, ...extra });
    return lines.length - 1;
  };

  const flush = (): void => {
    if (!bufferAt || buffer.length === 0) {
      buffer = [];
      bufferAt = null;
      return;
    }
    const text = normalizeWhitespace(buffer.join(' '));
    const at = bufferAt;
    buffer = [];
    bufferAt = null;
    if (text) push('text', `text: ${truncate(text, OUTLINE_LIMITS.textChars)}`, at);
  };

  const noteAnchor = (el: Element): void => {
    if (anchorOrder >= 0 || focusedLine >= 0) return;
    try {
      if (inViewport(el, win)) anchorOrder = order;
    } catch {
      // A detached or cross-realm element has no box here; the top of the page stands in.
    }
  };

  const addControl = (el: Element, ctx: WalkContext): void => {
    const role = controlRoleOf(el);
    if (!role) return;
    const focused = el === focusedEl;
    const name = truncate(normalizeWhitespace(controlName(el, ctx.doc, role)), OUTLINE_LIMITS.nameChars);
    if (!name && NEEDS_NAME.has(role) && !focused) return;
    flush();
    noteAnchor(el);
    const value = controlValue(el, role, name);
    const state = stateOf(el, role);
    const host = role === 'link' ? linkHost(el, ctx.doc) : undefined;
    const entry: RawControl = {
      el,
      role,
      name,
      ...(value ? { value } : {}),
      ...(state ? { state } : {}),
      ...(host ? { host } : {}),
      ...(ctx.fr !== undefined ? { fr: ctx.fr } : {}),
      ...(isRiskyName(name) ? { risky: true } : {}),
    };
    raw.push(entry);
    const index = push('control', renderControl(entry), ctx, { control: raw.length - 1, focused });
    if (focused) focusedLine = index;
    if (isSelect(el)) listOptions(el, ctx);
  };

  const listOptions = (el: HTMLSelectElement, ctx: WalkContext): void => {
    const inner = { indent: ctx.indent + 1, region: ctx.region };
    for (const option of Array.from(el.options).slice(0, OUTLINE_LIMITS.maxOptions)) {
      const label = truncate(normalizeWhitespace(option.text), OUTLINE_LIMITS.nameChars);
      if (!label) continue;
      push('option', `option ${quote(label)}${option.selected ? ' (selected)' : ''}`, inner);
    }
  };

  const spliceFrame = (report: FrameOutline, ctx: WalkContext): void => {
    const fr = frameNumber(doc, report.frame);
    const index = push('struct', 'frame:', ctx);
    const inner: WalkContext = { ...ctx, indent: ctx.indent + 1, region: index, fr };
    for (const c of report.controls) {
      const entry: RawControl = {
        el: report.frame,
        role: c.role,
        name: truncate(c.name, OUTLINE_LIMITS.nameChars),
        ...(c.value ? { value: truncate(c.value, OUTLINE_LIMITS.valueChars) } : {}),
        ...(c.state ? { state: c.state } : {}),
        ...(c.host ? { host: c.host } : {}),
        fr,
        frame: { token: report.token, remoteId: String(c.n) },
        ...(c.risky || isRiskyName(c.name) ? { risky: true } : {}),
      };
      raw.push(entry);
      push('control', renderControl(entry), inner, { control: raw.length - 1 });
    }
  };

  const visit = (el: Element, outer: WalkContext): void => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return;
    if (el.matches(JUNK)) return;
    if (!isVisible(el, outer.win)) return;

    const exempt = outer.exempt || el === focusRegion || el === focusedEl;
    if (!exempt && !holdsFocus(el) && offScreen(el)) {
      flush();
      hidden += countControls(el, outer.win);
      return;
    }
    const ctx = exempt === outer.exempt ? outer : { ...outer, exempt };

    if (isIframe(el) || tag === 'frame') {
      flush();
      const report = frames.find((f) => f.frame === el);
      if (report) {
        spliceFrame(report, ctx);
        return;
      }
      descendIntoFrame(el, ctx);
      return;
    }

    if (tag === 'dialog' && !(el as HTMLDialogElement).open) return;

    // A label's text is already the name of the control it labels; only the control itself is described.
    if (tag === 'label' && (el.querySelector('input,select,textarea') || el.getAttribute('for'))) {
      flush();
      walkChildren(el, { ...ctx, inNamed: true });
      return;
    }

    if (HEADING_TAGS.has(tag) || el.getAttribute('role') === 'heading') {
      const text = normalizeWhitespace(el.textContent ?? '');
      if (!text) return;
      flush();
      noteAnchor(el);
      push('heading', `${headingTag(el, tag)} ${truncate(text, OUTLINE_LIMITS.textChars)}`, ctx);
      return;
    }

    if (controlRoleOf(el)) {
      addControl(el, ctx);
      return;
    }

    const region = regionOf(el, tag);
    if (region) {
      const name = truncate(normalizeWhitespace(regionName(el, ctx.doc)), OUTLINE_LIMITS.nameChars);
      if (region.landmark || name) {
        flush();
        noteAnchor(el);
        const index = push('struct', name ? `${region.role} ${quote(name)}:` : `${region.role}:`, ctx, region.landmark ? { landmark: true } : {});
        walkChildren(el, { ...ctx, indent: ctx.indent + 1, region: index, inNamed: false });
        flush();
        return;
      }
    }

    if (tag === 'img') {
      const alt = normalizeWhitespace(el.getAttribute('alt') ?? '');
      if (alt && !ctx.inNamed) {
        flush();
        push('text', `image: ${truncate(alt, OUTLINE_LIMITS.textChars)}`, ctx);
      }
      return;
    }

    // A plain wrapper: no line of its own. Block-level ones end the text line they interrupt.
    if (!INLINE_TAGS.has(tag)) flush();
    walkChildren(el, ctx);
    if (!INLINE_TAGS.has(tag)) flush();
  };

  const walkChildren = (el: Element, ctx: WalkContext): void => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) {
        if (ctx.inNamed) continue;
        const text = normalizeWhitespace(node.nodeValue ?? '');
        if (!text) continue;
        bufferAt ??= { indent: ctx.indent, region: ctx.region };
        buffer.push(text);
        continue;
      }
      if (node.nodeType !== 1) continue;
      visit(node as Element, ctx);
    }
  };

  const descendIntoFrame = (el: Element, ctx: WalkContext): void => {
    if (ctx.depth >= OUTLINE_LIMITS.frameDepth) return;
    const child = reachableDocument(el);
    const childWin = child?.defaultView;
    if (!child?.body || !childWin) return;
    const fr = ctx.fr ?? frameNumber(doc, el);
    const index = push('struct', 'frame:', ctx);
    walkChildren(child.body, {
      indent: ctx.indent + 1,
      region: index,
      inNamed: false,
      win: childWin,
      doc: child,
      fr,
      depth: ctx.depth + 1,
      exempt: ctx.exempt,
    });
    flush();
  };

  walkChildren(doc.body, { indent: 0, region: -1, inNamed: false, win, doc, depth: 0, exempt: false });
  flush();

  const anchor = focusedLine >= 0 ? lines[focusedLine]!.order : Math.max(0, anchorOrder);
  capControls(lines, anchor, OUTLINE_LIMITS.maxControls);
  const notes = viewportNotes(win, doc, hidden);
  const room = Math.max(0, budget - noteSize(notes));
  const dropped = trim(lines, anchor, room, focusedLine);
  dropEmptyRegions(lines);

  return render(lines, raw, registry, dropped, room, notes);
}

/**
 * What the model is not being shown: how far the page is scrolled, how much of
 * it is still below, both in viewports, and how many controls were left off
 * screen. Without these lines the model reads a page cut off at the fold as
 * the whole page, and never answers `scroll`.
 */
function viewportNotes(win: Window, doc: Document, hidden: number): ViewportNotes {
  const vh = Math.max(1, win.innerHeight);
  const above = win.scrollY / vh;
  const below = (documentHeight(win, doc) - win.scrollY - win.innerHeight) / vh;
  const notes: ViewportNotes = {};
  if (above >= 0.05) notes.above = `(${above.toFixed(1)} screens above)`;
  const rest = below >= 0.05 ? `${below.toFixed(1)} more screens below` : '';
  const unseen = hidden > 0 ? `${hidden} control${hidden === 1 ? '' : 's'} not shown` : '';
  if (rest || unseen) notes.below = `(${[rest, unseen].filter((part) => part).join('; ')})`;
  return notes;
}

function noteSize(notes: ViewportNotes): number {
  return (notes.above ? notes.above.length + 1 : 0) + (notes.below ? notes.below.length + 1 : 0);
}

/** The region kept whole across the fold: the focused control's nearest landmark, or its nearest container. */
function regionAround(el: Element | null): Element | null {
  if (!el) return null;
  let nearest: Element | null = null;
  for (let node = el.parentElement, hops = 0; node && hops < 24; node = node.parentElement, hops++) {
    const region = regionOf(node, node.tagName.toLowerCase());
    if (!region) continue;
    if (region.landmark) return node;
    nearest ??= node;
  }
  return nearest;
}

/** Elements that could hold a control role, for counting what an off-screen subtree took with it. */
const CONTROL_CANDIDATES = 'a[href],button,input,select,textarea,summary,[role],[contenteditable],[tabindex],[onclick]';

function countControls(el: Element, win: Window): number {
  let n = controlRoleOf(el) ? 1 : 0;
  for (const node of Array.from(el.querySelectorAll(CONTROL_CANDIDATES))) {
    if (controlRoleOf(node) && isVisible(node, win)) n++;
  }
  return n;
}

/** A stable id for one outline, for the answer cache and the memo. */
export function snapshotHash(outline: string): string {
  return hashText(outline).toString(36);
}

function render(lines: OutlineLine[], raw: RawControl[], registry: Map<number, OutlineTarget>, dropped: number, budget: number, notes: ViewportNotes): PageOutline {
  const controls: OutlineControl[] = [];
  const out: string[] = [];
  let focused: number | undefined;
  let n = 0;
  for (const line of lines) {
    if (!line.keep) continue;
    let text = line.text;
    if (line.control !== undefined) {
      const entry = raw[line.control]!;
      n++;
      controls.push({
        n,
        role: entry.role,
        name: entry.name,
        ...(entry.value ? { value: entry.value } : {}),
        ...(entry.state ? { state: entry.state } : {}),
        ...(entry.host ? { host: entry.host } : {}),
        ...(entry.fr !== undefined ? { fr: entry.fr } : {}),
        ...(entry.risky ? { risky: true } : {}),
      });
      registry.set(n, { el: entry.el, ...(entry.fr !== undefined ? { fr: entry.fr } : {}), ...(entry.frame ? { frame: entry.frame } : {}) });
      text = `[${n}] ${text}`;
      if (line.focused) focused = n;
    }
    out.push(`${'  '.repeat(line.indent)}${line.focused ? '>> FOCUSED ' : ''}${text}`);
  }
  if (dropped > 0) out.push(`(${dropped} lines farther from the focus omitted)`);
  let body = out.join('\n');
  let kept = controls;
  if (body.length > budget) {
    // A page of nothing but landmarks can still overflow; cut whole lines off the end.
    const cut = body.lastIndexOf('\n', budget);
    body = cut > 0 ? body.slice(0, cut) : body.slice(0, budget);
    const live = new Set<number>();
    for (const m of body.matchAll(/\[(\d+)\]/g)) live.add(Number(m[1]));
    for (const c of controls) if (!live.has(c.n)) registry.delete(c.n);
    kept = controls.filter((c) => live.has(c.n));
    if (focused !== undefined && !live.has(focused)) focused = undefined;
  }
  const outline = [notes.above, body, notes.below].filter((part): part is string => Boolean(part)).join('\n');
  return { outline, controls: kept, registry, ...(focused !== undefined ? { focused } : {}) };
}

/** Drop the control lines farthest from the focus until at most `max` remain numbered. */
function capControls(lines: OutlineLine[], anchor: number, max: number): void {
  const controls = lines.filter((l) => l.kind === 'control');
  if (controls.length <= max) return;
  const doomed = controls
    .filter((l) => !l.focused)
    .sort((a, b) => Math.abs(b.order - anchor) - Math.abs(a.order - anchor))
    .slice(0, controls.length - max);
  for (const l of doomed) l.keep = false;
}

/** Line kinds in the order they are given up: page text first, headings last. */
const DROP_ORDER: LineKind[] = ['text', 'option', 'control', 'heading'];

/** The landmark the focused control sits in, whose lines are kept whole. */
function landmarkOf(lines: readonly OutlineLine[], focusedLine: number): number {
  if (focusedLine < 0) return -1;
  let last = -1;
  for (let r = lines[focusedLine]!.region, hops = 0; r >= 0 && hops < 16; r = lines[r]!.region, hops++) {
    last = r;
    if (lines[r]!.landmark) return r;
  }
  return last;
}

function trim(lines: OutlineLine[], anchor: number, budget: number, focusedLine: number): number {
  const protectedRegion = landmarkOf(lines, focusedLine);
  const firstInRegion = new Set<number>();
  const seen = new Set<number>();
  for (const line of lines) {
    if (line.kind === 'struct' || seen.has(line.region)) continue;
    seen.add(line.region);
    firstInRegion.add(line.order);
  }
  const inProtected = (line: OutlineLine): boolean => {
    if (protectedRegion < 0) return false;
    for (let r = line.region, hops = 0; r >= 0 && hops < 16; r = lines[r]!.region, hops++) {
      if (r === protectedRegion) return true;
    }
    return false;
  };

  let total = size(lines);
  if (total <= budget) return 0;
  let dropped = 0;
  for (const kind of DROP_ORDER) {
    const victims = lines
      .filter((l) => l.keep && l.kind === kind && !l.focused && !firstInRegion.has(l.order) && !inProtected(l))
      .sort((a, b) => Math.abs(b.order - anchor) - Math.abs(a.order - anchor));
    for (const v of victims) {
      if (total <= budget) return dropped;
      v.keep = false;
      dropped++;
      total -= lineSize(v);
    }
    if (total <= budget) break;
  }
  if (total <= budget) return dropped;
  // Still over: the focused landmark alone fills the budget, so give up its far lines too.
  for (const kind of DROP_ORDER) {
    const victims = lines
      .filter((l) => l.keep && l.kind === kind && !l.focused)
      .sort((a, b) => Math.abs(b.order - anchor) - Math.abs(a.order - anchor));
    for (const v of victims) {
      if (total <= budget) return dropped;
      v.keep = false;
      dropped++;
      total -= lineSize(v);
    }
  }
  return dropped;
}

/** A landmark whose whole content went is not worth a line of its own. */
function dropEmptyRegions(lines: OutlineLine[]): void {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.kind !== 'struct' || !line.keep) continue;
    let hasContent = false;
    for (let j = i + 1; j < lines.length && lines[j]!.indent > line.indent; j++) {
      if (lines[j]!.keep && lines[j]!.kind !== 'struct') {
        hasContent = true;
        break;
      }
    }
    if (!hasContent) line.keep = false;
  }
}

function size(lines: readonly OutlineLine[]): number {
  let total = 0;
  for (const l of lines) if (l.keep) total += lineSize(l);
  return total;
}

function lineSize(l: OutlineLine): number {
  return l.indent * 2 + l.text.length + (l.control !== undefined ? 5 : 0) + (l.focused ? 11 : 0) + 1;
}

function renderControl(c: RawControl): string {
  const name = c.name ? ` ${quote(c.name)}` : '';
  const value = c.value ? ` = ${quote(c.value)}` : '';
  const host = c.host ? ` -> ${c.host}` : '';
  const state = c.state ? ` (${c.state})` : '';
  return `${c.role}${name}${value}${host}${state}`;
}

function headingTag(el: Element, tag: string): string {
  if (HEADING_TAGS.has(tag)) return tag;
  const level = el.getAttribute('aria-level');
  return level && /^[1-6]$/.test(level) ? `h${level}` : 'h2';
}

function regionOf(el: Element, tag: string): { role: string; landmark: boolean } | null {
  const aria = el.getAttribute('role')?.toLowerCase();
  if (aria && LANDMARK_ROLES.has(aria)) return { role: aria === 'alertdialog' ? 'dialog' : aria, landmark: aria !== 'region' };
  if (aria && CONTAINER_ROLES.has(aria)) return { role: aria, landmark: false };
  const landmark = LANDMARK_TAGS[tag];
  if (landmark) return { role: landmark, landmark: true };
  const container = CONTAINER_TAGS[tag];
  return container ? { role: container, landmark: false } : null;
}

/** A region is named by its label, never by the text inside it. */
function regionName(el: Element, doc: Document): string {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (normalizeWhitespace(text)) return text;
  }
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const inner = el.querySelector(':scope > legend, :scope > caption, :scope > figcaption');
  if (inner?.textContent) return inner.textContent;
  return el.getAttribute('title') ?? el.getAttribute('name') ?? '';
}

/**
 * What the control is called. An editable one is never named by its own
 * content, which is its value, so only its labels and its placeholder count.
 */
function controlName(el: Element, doc: Document, role: ControlRole): string {
  const aria = el.getAttribute('aria-labelledby') || el.getAttribute('aria-label') ? accessibleName(el, doc) : '';
  if (aria) return aria;
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || isSelect(el)) {
    return labelOf(el, doc) ?? el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '';
  }
  return accessibleName(el, doc) || el.getAttribute('name') || '';
}

function controlValue(el: Element, role: ControlRole, name: string): string {
  if (isSecretField(el, name)) return '';
  let value = '';
  if (isSelect(el)) value = el.selectedOptions[0]?.text ?? '';
  else if (isInput(el) || isTextArea(el)) value = el.value;
  else if (isEditable(el)) value = el.textContent ?? '';
  else value = el.getAttribute('aria-valuetext') ?? el.getAttribute('aria-valuenow') ?? '';
  // A link's href is noise, and a value that only repeats the name is too.
  if (role === 'link') return '';
  const text = truncate(normalizeWhitespace(value), OUTLINE_LIMITS.valueChars);
  return text === name ? '' : text;
}

function linkHost(el: Element, doc: Document): string | undefined {
  const href = el.getAttribute('href');
  if (!href || href.startsWith('#')) return undefined;
  try {
    const url = new URL(href, doc.baseURI);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return registrableDomain(url.hostname) || undefined;
  } catch {
    return undefined;
  }
}

function reachableDocument(frame: Element): Document | null {
  try {
    return (frame as HTMLIFrameElement).contentDocument ?? null;
  } catch {
    return null;
  }
}

/** The focused element, following frames and shadow roots down to the real one. */
export function deepActiveElement(doc: Document): Element | null {
  let el: Element | null = doc.activeElement;
  for (let hops = 0; el && hops < 8; hops++) {
    if (isIframe(el)) {
      const child = reachableDocument(el);
      if (!child?.activeElement) break;
      el = child.activeElement;
      continue;
    }
    const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow?.activeElement) {
      el = shadow.activeElement;
      continue;
    }
    break;
  }
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  return tag === 'body' || tag === 'html' ? null : el;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

/** Exported for the tests that check what the walk refuses to look at. */
export const OUTLINE_JUNK_SELECTOR = JUNK;
