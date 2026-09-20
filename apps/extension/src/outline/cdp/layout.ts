/** A box in the top frame's viewport coordinates, in CSS pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The bits of `DOMSnapshot.captureSnapshot` carat reads. Everything in it is
 * index-into-`strings` rather than text, which is why one call can carry the
 * geometry and the hrefs of a whole page cheaply.
 */
export interface DomSnapshotReply {
  documents?: DocumentSnapshot[];
  strings?: string[];
}

export interface DocumentSnapshot {
  nodes?: {
    backendNodeId?: number[];
    /** Per node, a flat [nameIndex, valueIndex, ...] list of string indices. */
    attributes?: number[][];
  };
  layout?: {
    /** Per laid-out box, the index of its node in `nodes`. */
    nodeIndex?: number[];
    /** Per laid-out box, [x, y, width, height] in the document's own coordinates. */
    bounds?: number[][];
  };
  scrollOffsetX?: number;
  scrollOffsetY?: number;
}

export interface PageLayout {
  /** backendNodeId -> box in the top frame's viewport. Only the top document; see below. */
  boxes: Map<number, Box>;
  /** backendNodeId -> the `href` attribute, for the host written after a link. */
  hrefs: Map<number, string>;
}

/**
 * Geometry and hrefs for one page, from a single `DOMSnapshot.captureSnapshot`.
 *
 * Only the first document, the top frame, contributes boxes: a child frame's
 * bounds are in its own document's coordinates, and placing them in the top
 * frame's would need the frame element's own box on top. A node with no box is
 * never gated out, so a control inside a frame is described whether or not the
 * frame is scrolled, which is the safe way round. Hrefs are read from every
 * document, since they need no coordinates.
 */
export function readLayout(reply: DomSnapshotReply): PageLayout {
  const boxes = new Map<number, Box>();
  const hrefs = new Map<number, string>();
  const strings = reply.strings ?? [];
  const documents = reply.documents ?? [];

  documents.forEach((doc, index) => {
    const ids = doc.nodes?.backendNodeId ?? [];
    const attributes = doc.nodes?.attributes ?? [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const attrs = attributes[i];
      if (id === undefined || !attrs) continue;
      for (let a = 0; a + 1 < attrs.length; a += 2) {
        if (strings[attrs[a]!] !== 'href') continue;
        const value = strings[attrs[a + 1]!];
        if (value) hrefs.set(id, value);
        break;
      }
    }
    if (index !== 0) return;
    const scrollX = doc.scrollOffsetX ?? 0;
    const scrollY = doc.scrollOffsetY ?? 0;
    const nodeIndex = doc.layout?.nodeIndex ?? [];
    const bounds = doc.layout?.bounds ?? [];
    for (let i = 0; i < nodeIndex.length; i++) {
      const id = ids[nodeIndex[i]!];
      const box = bounds[i];
      if (id === undefined || !box || box.length < 4) continue;
      boxes.set(id, { x: box[0]! - scrollX, y: box[1]! - scrollY, w: box[2]!, h: box[3]! });
    }
  });

  return { boxes, hrefs };
}

/**
 * `DOM.getBoxModel`'s content quad as a box. Chromium hands these back in the
 * top frame's viewport coordinates already, so nothing is subtracted unless a
 * caller says otherwise. This is the per-node fallback for when there was no
 * page snapshot to read the geometry from.
 */
export function boxFromModel(model: { model?: { content?: number[] } } | undefined, scrollX = 0, scrollY = 0): Box | undefined {
  const quad = model?.model?.content;
  if (!quad || quad.length < 8) return undefined;
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: x - scrollX, y: y - scrollY, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
