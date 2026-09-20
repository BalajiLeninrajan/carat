import type { ControlRole, OutlineControl } from '@carat/shared';
import { hashText, normalizeWhitespace, registrableDomain, truncate } from '@carat/shared';
import { isVisible } from '../capture/visibility';
import { isSecretField } from '../dom/secret';
import { isIframe, isInput, isSelect, isTextArea } from '../dom/tags';
import type { FrameLine, FrameRef } from '../frames/protocol';
import { FRAME_MAX_INDENT, FRAME_MAX_LINES, frameNumber } from '../frames/protocol';
import { textExcluding } from '../snapshot/labels';
import { documentHeight, inViewport, viewportRect } from '../scroll';
import { controlRoleOf, isEditable, isRiskyName, popupListOf, popupOf, stateOf } from './roles';

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
  /** Open shadow roots are walked this many roots deep; what is nested deeper is left out. */
  shadowDepth: 8,
  /** Elements one walk may look at, light DOM and shadow roots together. */
  maxNodes: 20000,
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
/**
 * Roles whose content is their value, not their name. A combobox is never
 * called after whatever has been typed into it, and a listbox is never called
 * after the options inside it — which is how `ul[role=listbox]` used to reach
 * the model as `select "Montreal Moncton Montmagny"`.
 */
const TAKES_VALUE = new Set<ControlRole>(['textbox', 'searchbox', 'combobox', 'select', 'slider']);
/**
 * Roles that wrap the control the user actually types in: the ARIA 1.1
 * combobox is a div with the role and a real `<input>` inside it. The
 * accessibility tree exposes both, and only the inner one can be filled, so
 * the walk carries on through these instead of stopping at the wrapper.
 */
const WRAPS_A_FIELD = new Set<ControlRole>(['combobox', 'select']);
/** What `WRAPS_A_FIELD` goes looking for: a field a fill could actually land in. */
const FIELD_INSIDE = 'input:not([type="hidden"]),textarea,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
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
  /** What pressing it opens, from `aria-haspopup`. */
  popup?: string;
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
  /** The child's own outline lines, prose included. Without them only the controls are spliced. */
  lines?: readonly FrameLine[];
  /** The child's notes about its own fold, when it scrolls independently. */
  summary?: readonly string[];
  /** The child's host, for the line written above its lines. */
  host?: string;
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
  /**
   * How many controls the outline actually numbered, and how many operable
   * controls the walk found on the page. When they differ the closing line
   * says so, because a model shown eighteen of a booking form's forty-six
   * controls and told nothing has every reason to believe the one it wants is
   * further down, and to answer `scroll`.
   */
  describedControls: number;
  pageControls: number;
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
  /** How many open shadow roots this node sits inside. */
  shadow: number;
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
 * An element with an open shadow root is walked through its root instead of
 * its light children, and a `<slot>` is walked through the nodes assigned to
 * it, so a page built from web components reads in composed order and its
 * controls are numbered like any other. The registry holds the real element
 * inside the root, so perform reaches it. A closed root is opaque: Chrome
 * gives `shadowRoot` as null and carat does not go looking, so a component
 * that closes its root contributes only its host's own box.
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
  if (!win || !doc.body) return { outline: '', controls: [], registry, describedControls: 0, pageControls: 0 };

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
  /** Lists already described under the combobox that owns them; the walk does not describe them twice. */
  const listed = new Set<Element>();
  /** Elements looked at so far; a component tree that loops or fans out stops here. */
  let seenNodes = 0;

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
  // `contains` stops at a shadow boundary, so the path is composed: the host
  // of the root the focus sits in holds it too.
  const focusPath = composedPath(focusedEl);
  const holdsFocus = (el: Element): boolean => focusPath.has(el);

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
    const popup = popupOf(el);
    const entry: RawControl = {
      el,
      role,
      name,
      ...(value ? { value } : {}),
      ...(state ? { state } : {}),
      ...(host ? { host } : {}),
      ...(popup ? { popup } : {}),
      ...(ctx.fr !== undefined ? { fr: ctx.fr } : {}),
      ...(isRiskyName(name) ? { risky: true } : {}),
    };
    raw.push(entry);
    const index = push('control', renderControl(entry), ctx, { control: raw.length - 1, focused });
    if (focused) focusedLine = index;
    // The ARIA 1.1 combobox: the role is on the wrapper and the field is
    // inside it. Both are numbered, because only the inner one can be filled,
    // and the field comes before the list the way the user meets them.
    if (WRAPS_A_FIELD.has(role) && !isSelect(el) && el.querySelector(FIELD_INSIDE)) {
      walkChildren(el, { ...ctx, indent: ctx.indent + 1, region: ctx.region, inNamed: true });
      flush();
    }
    if (isSelect(el)) listOptions(Array.from(el.options).map((o) => ({ label: o.text, selected: o.selected })), ctx);
    // A listbox the page built out of `<ul>` and `<li role=option>` reads the same way a `<select>` does.
    else if (role === 'select') listOptions(optionsIn(el, ctx.win), ctx);
    else listPopup(el, ctx);
  };

  const listOptions = (options: readonly { label: string; selected: boolean }[], ctx: Pick<WalkContext, 'indent' | 'region'>): void => {
    const inner = { indent: ctx.indent + 1, region: ctx.region };
    for (const option of options.slice(0, OUTLINE_LIMITS.maxOptions)) {
      const label = truncate(normalizeWhitespace(option.label), OUTLINE_LIMITS.nameChars);
      if (!label) continue;
      push('option', `option ${quote(label)}${option.selected ? ' (selected)' : ''}`, inner);
    }
  };

  /**
   * The list an open combobox is showing. The options live in a separate
   * element the control points at with `aria-controls`, so without following
   * that an expanded picker reads as expanded onto nothing and the model has
   * no option text to answer `select` with. The list is only read where it is
   * really on screen; a picker's markup is usually in the page whether it is
   * open or not.
   */
  const listPopup = (el: Element, ctx: WalkContext): void => {
    const list = popupListOf(el, idScope(el, ctx.doc));
    if (!list || list === el || !isVisible(list, ctx.win) || offScreen(list)) return;
    const options = optionsIn(list, ctx.win);
    if (options.length === 0) return;
    listOptions(options, ctx);
    // Its options are described here, so the list itself is not described again.
    listed.add(list);
  };

  /**
   * A cross-origin child frame's own outline, put where its frame element
   * sits, under a line naming the frame. The child's lines keep their order
   * and their nesting; its controls are renumbered into this page's sequence
   * and registered against the frame, so performing one goes back through
   * the hub. Everything in the report is another document's text. It is
   * truncated and normalised here, and it counts against this page's budget
   * like a region of the page's own.
   */
  const spliceFrame = (report: FrameOutline, ctx: WalkContext): void => {
    const clean = (text: string, chars: number): string => truncate(normalizeWhitespace(String(text ?? '')), chars);
    const fr = frameNumber(doc, report.frame);
    const host = clean(report.host ?? '', OUTLINE_LIMITS.nameChars);
    const index = push('struct', host ? `frame ${host}:` : 'frame:', ctx);
    const base = ctx.indent + 1;
    const byNumber = new Map<number, OutlineControl>();
    for (const c of report.controls) byNumber.set(c.n, c);

    // Child indent -> the line index that opened it, so a nested region's lines are trimmed with it.
    const openedAt = new Map<number, number>();
    const regionFor = (depth: number): number => {
      for (let d = depth - 1; d >= 0; d--) {
        const at = openedAt.get(d);
        if (at !== undefined) return at;
      }
      return index;
    };

    const placed = new Set<number>();
    const addRemote = (c: OutlineControl, at: { indent: number; region: number }): void => {
      placed.add(c.n);
      const name = clean(c.name, OUTLINE_LIMITS.nameChars);
      const entry: RawControl = {
        el: report.frame,
        role: c.role,
        name,
        ...(c.value ? { value: clean(c.value, OUTLINE_LIMITS.valueChars) } : {}),
        ...(c.state ? { state: clean(c.state, OUTLINE_LIMITS.nameChars) } : {}),
        ...(c.host ? { host: clean(c.host, OUTLINE_LIMITS.nameChars) } : {}),
        ...(c.popup ? { popup: clean(c.popup, OUTLINE_LIMITS.nameChars) } : {}),
        fr,
        frame: { token: report.token, remoteId: String(c.n) },
        ...(c.risky || isRiskyName(name) ? { risky: true } : {}),
      };
      raw.push(entry);
      push('control', renderControl(entry), at, { control: raw.length - 1 });
    };

    for (const line of (report.lines ?? []).slice(0, FRAME_MAX_LINES)) {
      const depth = Math.min(Math.max(Math.trunc(line.indent) || 0, 0), FRAME_MAX_INDENT);
      for (const open of [...openedAt.keys()]) if (open >= depth) openedAt.delete(open);
      const at = { indent: base + depth, region: regionFor(depth) };
      if (line.kind === 'control') {
        const c = byNumber.get(line.n);
        if (c && !placed.has(c.n)) addRemote(c, at);
        continue;
      }
      const text = clean(line.text, OUTLINE_LIMITS.textChars);
      if (!text) continue;
      const opened = push(line.kind, text, at);
      if (line.kind === 'struct') openedAt.set(depth, opened);
    }
    // A child too old to send lines, or one whose lines lost a control: list what is left flat.
    for (const c of report.controls) if (!placed.has(c.n)) addRemote(c, { indent: base, region: index });
    for (const note of report.summary ?? []) {
      const text = clean(note, OUTLINE_LIMITS.nameChars);
      if (text) push('text', text, { indent: base, region: index });
    }
  };

  const visit = (el: Element, outer: WalkContext): void => {
    if (seenNodes++ > OUTLINE_LIMITS.maxNodes) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return;

    // A slot is a hole, not a thing: it has no box of its own, so the
    // visibility check cannot be asked about it, and each node that lands in
    // it is judged where it lands rather than where it was written. A root
    // that hides a slot outright hides what was put in it.
    if (tag === 'slot') {
      if (isHiddenSlot(el, outer.win)) return;
      walkNodes(slotted(el), outer);
      return;
    }

    if (el.matches(JUNK)) return;
    // The combobox that owns this list has already laid its options out.
    if (listed.has(el)) return;
    // `display: contents` is how a component host gets out of the way; it has
    // no box, so the visibility check calls it invisible while its content is
    // on screen. Everything inside is checked on its own anyway.
    if (!isVisible(el, outer.win) && !isBoxless(el, outer.win)) return;

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
      const name = truncate(normalizeWhitespace(regionName(el, idScope(el, ctx.doc))), OUTLINE_LIMITS.nameChars);
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

  // An open shadow root replaces the light children it was given: those reach
  // the outline through the slots inside the root, in the order the root puts
  // them in. A closed root leaves `shadowRoot` null, so the host walks its own
  // children and the component's insides stay unread.
  const walkChildren = (el: Element, ctx: WalkContext): void => {
    const root = openShadowRoot(el);
    if (!root) {
      walkNodes(Array.from(el.childNodes), ctx);
      return;
    }
    if (ctx.shadow >= OUTLINE_LIMITS.shadowDepth) return;
    walkNodes(Array.from(root.childNodes), { ...ctx, shadow: ctx.shadow + 1 });
  };

  const walkNodes = (nodes: readonly Node[], ctx: WalkContext): void => {
    for (const node of nodes) {
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
      shadow: 0,
      exempt: ctx.exempt,
    });
    flush();
  };

  walkChildren(doc.body, { indent: 0, region: -1, inNamed: false, win, doc, depth: 0, shadow: 0, exempt: false });
  flush();

  const anchor = focusedLine >= 0 ? lines[focusedLine]!.order : Math.max(0, anchorOrder);
  capControls(lines, anchor, OUTLINE_LIMITS.maxControls);
  dropNameEchoes(lines, raw);
  // Every operable control the walk found, described or not: the ones it put
  // on a line, plus the ones an off-screen subtree took with it.
  const pageControls = raw.length + hidden;
  const makeNotes = (described: number): ViewportNotes => viewportNotes(win, doc, hidden, described, pageControls);
  // The closing line's own length depends on a count the trim has not settled
  // yet, so the trim reserves the longest that line could be.
  const room = Math.max(0, budget - noteSize(makeNotes(Math.max(0, pageControls - 1))));
  const dropped = trim(lines, anchor, room, focusedLine);
  dropEmptyRegions(lines);

  return render(lines, raw, registry, dropped, room, makeNotes, pageControls);
}

/**
 * What the model is not being shown: how far the page is scrolled, how much of
 * it is still below, both in viewports, and how many controls were left off
 * screen. Without these lines the model reads a page cut off at the fold as
 * the whole page, and never answers `scroll`.
 */
function viewportNotes(win: Window, doc: Document, hidden: number, described: number, pageControls: number): ViewportNotes {
  const vh = Math.max(1, win.innerHeight);
  const above = win.scrollY / vh;
  const below = (documentHeight(win, doc) - win.scrollY - win.innerHeight) / vh;
  const notes: ViewportNotes = {};
  if (above >= 0.05) notes.above = `(${above.toFixed(1)} screens above)`;
  const rest = below >= 0.05 ? `${below.toFixed(1)} more screens below` : '';
  const unseen = hidden > 0 ? `${hidden} control${hidden === 1 ? '' : 's'} not shown` : '';
  // Said only when the budget really did cut the list short. The off-screen
  // count above says what the fold took; this says what the budget took, and
  // the two are different reasons for the model to distrust the list.
  const trimmed = described < pageControls - hidden ? `only ${described} of ${pageControls} controls described` : '';
  const parts = [rest, unseen, trimmed].filter((part) => part);
  if (parts.length > 0) notes.below = `(${parts.join('; ')})`;
  return notes;
}

function noteSize(notes: ViewportNotes): number {
  return (notes.above ? notes.above.length + 1 : 0) + (notes.below ? notes.below.length + 1 : 0);
}

/** The region kept whole across the fold: the focused control's nearest landmark, or its nearest container. */
function regionAround(el: Element | null): Element | null {
  if (!el) return null;
  let nearest: Element | null = null;
  for (let node = composedParent(el), hops = 0; node && hops < 24; node = composedParent(node), hops++) {
    const region = regionOf(node, node.tagName.toLowerCase());
    if (!region) continue;
    if (region.landmark) return node;
    nearest ??= node;
  }
  return nearest;
}

/**
 * The shadow root carat is allowed to read. Chrome hands back null for a
 * closed root, and carat does not go around that: a component that closes its
 * root stays opaque, and nothing inside it is numbered or offered.
 */
function openShadowRoot(el: Element): ShadowRoot | null {
  try {
    const root = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
    return root?.mode === 'open' ? root : null;
  } catch {
    return null;
  }
}

/** What a slot actually shows: the nodes assigned to it, or its fallback when nothing was. */
function slotted(el: Element): Node[] {
  const slot = el as Element & { assignedNodes?: (opts?: { flatten?: boolean }) => Node[] };
  if (typeof slot.assignedNodes !== 'function') return Array.from(el.childNodes);
  try {
    const assigned = slot.assignedNodes({ flatten: true });
    return assigned.length > 0 ? assigned : Array.from(el.childNodes);
  } catch {
    return Array.from(el.childNodes);
  }
}

/** A slot the root has switched off, along with whatever was slotted into it. */
function isHiddenSlot(el: Element, win: Window): boolean {
  try {
    const style = win.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  } catch {
    return false;
  }
}

function isShadowRoot(node: Node | null): node is ShadowRoot {
  return node !== null && node.nodeType === 11 && 'host' in node;
}

/** Up one step in the composed tree: out of an open shadow root through its host. */
function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.parentNode;
  return isShadowRoot(root) ? root.host : null;
}

/** The element and everything that holds it, shadow hosts included. */
function composedPath(el: Element | null): Set<Element> {
  const path = new Set<Element>();
  for (let node = el, hops = 0; node && hops < 64; node = composedParent(node), hops++) path.add(node);
  return path;
}

/**
 * Where an element's id references resolve. Inside a shadow root that is the
 * root, not the document: `aria-labelledby="label"` on a control in a root
 * names an element in the same root, and the document may well have its own
 * `#label`. A root answers `getElementById` and `querySelectorAll`, which is
 * all the naming helpers ask of the document they are handed.
 */
function idScope(el: Element, doc: Document): Document {
  const root = el.getRootNode();
  if (root === doc) return doc;
  if (isShadowRoot(root)) return root as unknown as Document;
  return root.nodeType === 9 ? (root as Document) : doc;
}

/**
 * An element with no box of its own, `display: contents`, which is not the
 * same as hidden: `checkVisibility` says false for both. Its content is on
 * screen as long as what holds it is.
 */
function isBoxless(el: Element, win: Window): boolean {
  try {
    const style = win.getComputedStyle(el);
    if (style.display !== 'contents' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const parent = composedParent(el);
    return !parent || isVisible(parent, win);
  } catch {
    return false;
  }
}

/** Elements that could hold a control role, for counting what an off-screen subtree took with it. */
const CONTROL_CANDIDATES = 'a[href],button,input,select,textarea,summary,[role],[contenteditable],[tabindex],[onclick]';

function countControls(el: Element, win: Window, depth = 0): number {
  let n = controlRoleOf(el) ? 1 : 0;
  for (const node of Array.from(el.querySelectorAll(CONTROL_CANDIDATES))) {
    if (controlRoleOf(node) && isVisible(node, win)) n++;
  }
  if (depth >= OUTLINE_LIMITS.shadowDepth) return n;
  // Controls the subtree took with it include the ones inside its components.
  for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) {
    const root = openShadowRoot(node);
    if (!root) continue;
    for (const child of Array.from(root.children)) n += countControls(child, win, depth + 1);
  }
  return n;
}

/** A stable id for one outline, for the answer cache and the memo. */
export function snapshotHash(outline: string): string {
  return hashText(outline).toString(36);
}

function render(
  lines: OutlineLine[],
  raw: RawControl[],
  registry: Map<number, OutlineTarget>,
  dropped: number,
  budget: number,
  makeNotes: (described: number) => ViewportNotes,
  pageControls: number,
): PageOutline {
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
        ...(entry.popup ? { popup: entry.popup } : {}),
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
  const notes = makeNotes(kept.length);
  const outline = [notes.above, body, notes.below].filter((part): part is string => Boolean(part)).join('\n');
  return {
    outline,
    controls: kept,
    registry,
    describedControls: kept.length,
    pageControls,
    ...(focused !== undefined ? { focused } : {}),
  };
}

/**
 * A label the outline has already used as a control's name is not also a line
 * of page prose. Without this, a field named from the `<label>` beside it
 * reads as `text: Discount code` followed by `[7] textbox "Discount code"`,
 * which is the same words twice and a hint that the two are separate things.
 */
function dropNameEchoes(lines: OutlineLine[], raw: readonly RawControl[]): void {
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (line.kind !== 'text' || !line.keep) continue;
    const next = lines[i + 1]!;
    if (next.control === undefined || !next.keep) continue;
    const name = raw[next.control]!.name;
    if (name && line.text === `text: ${name}`) line.keep = false;
  }
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
  // Its own clause rather than another word inside the state's: what a
  // control opens is not a state it is in.
  const popup = c.popup ? ` (opens ${c.popup})` : '';
  return `${c.role}${name}${value}${host}${state}${popup}`;
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
 * What the control is called, in the order the accessible-name computation
 * uses it: `aria-labelledby`, then `aria-label`, then the native label —
 * `label[for]` or a wrapping one — then the value of a push button and the
 * alt of an image button, then the element's own text for the roles whose
 * text is their name, then the placeholder, the title, and the alt of an
 * image inside.
 *
 * Two deliberate departures from the specification, both of them because a
 * nameless control is worth nothing to the model and the page's author
 * plainly meant to name it:
 *
 * - `aria-labelledby` inside a shadow root is looked up in the root first, as
 *   the specification says, and then outward through each host's root to the
 *   document. A component that labels its input from the page around it gets
 *   no name at all in the real accessibility tree; carat takes the one that
 *   was obviously intended.
 * - A `<label>` with no `for=` sitting beside the control, which names
 *   nothing in the accessibility tree, is used when nothing else named it.
 *   Hand-rolled booking forms are full of them.
 *
 * A control whose content is its value — a text field, a combobox, a listbox
 * — is never named by that content.
 */
function controlName(el: Element, doc: Document, role: ControlRole): string {
  const labelled = labelledByText(el, doc);
  if (labelled) return labelled;
  const aria = normalizeWhitespace(el.getAttribute('aria-label') ?? '');
  if (aria) return aria;
  const native = nativeLabelText(el);
  if (native) return native;
  if (isInput(el)) {
    const type = el.type.toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') {
      const value = normalizeWhitespace(el.value);
      if (value) return value;
    }
    if (type === 'image') {
      const alt = normalizeWhitespace(el.alt);
      if (alt) return alt;
    }
  }
  if (!TAKES_VALUE.has(role) && !isEditable(el) && !isInput(el) && !isTextArea(el)) {
    const own = normalizeWhitespace(el.textContent ?? '');
    if (own) return own;
  }
  const placeholder = normalizeWhitespace(el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? '');
  if (placeholder) return placeholder;
  const title = normalizeWhitespace(el.getAttribute('title') ?? '');
  if (title) return title;
  // Only for a control named by what is in it: the alt inside a listbox would
  // be an option's, which is its value.
  const image = TAKES_VALUE.has(role) ? '' : imageText(el);
  if (image) return image;
  const near = siblingLabelText(el);
  if (near) return near;
  return normalizeWhitespace(el.getAttribute('name') ?? '');
}

/**
 * The text of everything `aria-labelledby` points at. Each id is resolved in
 * the element's own root first and then outward, so a control inside a
 * component is named by its component's label where there is one and by the
 * page's where there is not.
 */
function labelledByText(el: Element, doc: Document): string {
  const attr = el.getAttribute('aria-labelledby');
  if (!attr) return '';
  const parts: string[] = [];
  for (const id of attr.split(/\s+/)) {
    if (!id) continue;
    const source = elementById(el, id, doc);
    if (!source) continue;
    // A label that holds the control does not name it with the control's own value.
    parts.push(source.contains(el) ? textExcluding(source, el) : normalizeWhitespace(source.textContent ?? ''));
  }
  return normalizeWhitespace(parts.filter(Boolean).join(' '));
}

/** An id looked up in the element's root, then in each root out to the document. */
function elementById(el: Element, id: string, doc: Document): Element | null {
  for (let root: Node = el.getRootNode(), hops = 0; hops < OUTLINE_LIMITS.shadowDepth; hops++) {
    const scope = root as unknown as { getElementById?: (id: string) => Element | null };
    const found = typeof scope.getElementById === 'function' ? scope.getElementById(id) : null;
    if (found) return found;
    if (!isShadowRoot(root)) break;
    root = root.host.getRootNode();
  }
  return doc.getElementById(id);
}

/** `label[for]` in the control's own root, or the label the control sits inside. */
function nativeLabelText(el: Element): string {
  const root = el.getRootNode() as unknown as ParentNode;
  if (el.id && typeof root.querySelectorAll === 'function') {
    // `label[for=...]` would need CSS.escape, which jsdom lacks; htmlFor is exact anyway.
    for (const label of Array.from(root.querySelectorAll('label[for]'))) {
      if ((label as HTMLLabelElement).htmlFor !== el.id) continue;
      const text = normalizeWhitespace(label.textContent ?? '');
      if (text) return text;
    }
  }
  const wrapping = el.closest('label');
  return wrapping ? textExcluding(wrapping, el) : '';
}

/** How far out from a control a stray `<label>` may sit and still be taken for its name. */
const LABEL_CLIMB = 3;
const LABEL_SIBLINGS = 4;

/**
 * A `<label>` with no `for=` beside the control, or beside something holding
 * it. The accessibility tree ignores these; a booking form that writes
 * `<label>Discount code</label><input>` still means them, and without this
 * the model is offered an anonymous box next to a line of loose prose.
 */
function siblingLabelText(el: Element): string {
  for (let node: Element | null = el, hops = 0; node && hops < LABEL_CLIMB; node = node.parentElement, hops++) {
    let seen = 0;
    for (let sib = node.previousElementSibling; sib && seen < LABEL_SIBLINGS; sib = sib.previousElementSibling, seen++) {
      const label = sib.tagName.toLowerCase() === 'label' ? sib : sib.querySelector(':scope > label:not([for])');
      // A label with a `for` names some other control, and one wrapping a
      // control of its own has already named that one.
      if (!label || label.hasAttribute('for') || label.querySelector(FIELD_INSIDE)) continue;
      const text = normalizeWhitespace(label.textContent ?? '');
      if (text) return text;
    }
  }
  return '';
}

/** The alt of an image inside a control that has no text of its own. */
function imageText(el: Element): string {
  const img = el.querySelector('img[alt],svg title,[aria-label]');
  if (!img) return '';
  return normalizeWhitespace(img.getAttribute('alt') ?? img.getAttribute('aria-label') ?? img.textContent ?? '');
}

/** The options of a listbox the page built itself, in the shape `listOptions` takes. */
function optionsIn(list: Element, win: Window): { label: string; selected: boolean }[] {
  const out: { label: string; selected: boolean }[] = [];
  for (const option of Array.from(list.querySelectorAll('[role="option"]'))) {
    if (!isVisible(option, win)) continue;
    out.push({ label: normalizeWhitespace(option.textContent ?? ''), selected: option.getAttribute('aria-selected') === 'true' });
  }
  return out;
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
