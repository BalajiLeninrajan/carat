import type { NextActionRequest, PageScroll } from '@carat/shared';
import { LIMITS, normalizeWhitespace, truncate } from '@carat/shared';
import { hasMoreBelow, viewportsOf } from '../scroll';
import type { FrameOutline, OutlineTarget } from './build';
import { buildOutline, snapshotHash } from './build';

/** The half of the request the page itself answers; the background fills in the rest. */
export type PageEvidence = Omit<NextActionRequest, 'history' | 'notes' | 'tabs' | 'now' | 'eagerness'>;

export interface RequestMeta {
  /** Defaults to the document's own location; jsdom will not let a test move the real one. */
  location?: Pick<Location, 'host' | 'pathname'>;
  /** Cross-origin child frames, as the hub last heard them. */
  frames?: readonly FrameOutline[];
  /** Characters the outline may take. 9000 by default; a first fast ask passes 4000. */
  budget?: number;
  focused?: Element | null;
}

export interface Evidence {
  request: PageEvidence;
  /** n -> what to act on when the chip is accepted. Stays in the content script. */
  registry: Map<number, OutlineTarget>;
  /** The outline's hash, for the answer memo. */
  hash: string;
}

/**
 * Everything about the page the engine needs: where it is, how far down it
 * the user has read, the outline, the controls it numbers and which of them
 * has the focus. The background adds the timeline, the notes, the open tabs,
 * the clock and the settings before the engine sees it.
 */
export function assembleRequest(doc: Document, win: Window | null = doc.defaultView, meta: RequestMeta = {}): PageEvidence {
  return assembleEvidence(doc, win, meta).request;
}

/** The same, with the registry and the hash the content script keeps for itself. */
export function assembleEvidence(doc: Document, win: Window | null = doc.defaultView, meta: RequestMeta = {}): Evidence {
  const location = meta.location ?? doc.location;
  const built = buildOutline(doc, win, {
    ...(meta.budget !== undefined ? { budget: meta.budget } : {}),
    ...(meta.frames ? { frames: meta.frames } : {}),
    ...(meta.focused !== undefined ? { focused: meta.focused } : {}),
  });
  const request: PageEvidence = {
    page: {
      host: location.host,
      title: truncate(normalizeWhitespace(doc.title), LIMITS.titleChars),
      path: location.pathname,
      scroll: scrollOf(doc, win),
    },
    outline: built.outline,
    controls: built.controls,
    ...(built.focused !== undefined ? { focused: built.focused } : {}),
  };
  return { request, registry: built.registry, hash: snapshotHash(built.outline) };
}

export function scrollOf(doc: Document, win: Window | null = doc.defaultView): PageScroll {
  if (!win) return { y: 0, pages: 1, more: false };
  const { y, pages } = viewportsOf(win, doc);
  return { y, pages, more: hasMoreBelow(win, doc) };
}
