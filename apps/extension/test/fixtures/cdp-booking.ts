import type { AXNode } from '../../src/outline/cdp';

/**
 * A booking page as Chrome's accessibility tree describes it: a guests
 * combobox with its options, a date button that opens a dialog, a focused
 * email field, an irreversible confirm button, a link off to another host, one
 * control far below the fold, and a payment form in a cross-origin frame.
 *
 * The numbers are backendDOMNodeIds; `BOXES` places them in an 800x600
 * viewport over an 1800px page, which is what makes "Back to top" off screen.
 */
export const TOP_FRAME = 'FRAME_TOP';
export const PAY_FRAME = 'FRAME_PAY';

export const NODE = {
  root: 1,
  main: 2,
  heading: 3,
  form: 4,
  guests: 5,
  guest1: 6,
  guest2: 7,
  guest3: 8,
  dates: 9,
  email: 10,
  confirm: 11,
  policy: 12,
  backToTop: 13,
  payFrame: 14,
  payRoot: 15,
  cardNumber: 16,
  pay: 17,
} as const;

interface NodeSpec {
  id: string;
  backend?: number;
  role: string;
  name?: string;
  value?: string;
  ignored?: boolean;
  parent?: string;
  children?: string[];
  props?: Record<string, unknown>;
  frameId?: string;
}

function node(spec: NodeSpec): AXNode {
  return {
    nodeId: spec.id,
    ignored: spec.ignored ?? false,
    role: { type: 'role', value: spec.role },
    ...(spec.name !== undefined ? { name: { type: 'computedString', value: spec.name } } : {}),
    ...(spec.value !== undefined ? { value: { type: 'computedString', value: spec.value } } : {}),
    ...(spec.parent !== undefined ? { parentId: spec.parent } : {}),
    ...(spec.children ? { childIds: spec.children } : {}),
    ...(spec.backend !== undefined ? { backendDOMNodeId: spec.backend } : {}),
    ...(spec.frameId ? { frameId: spec.frameId } : {}),
    ...(spec.props
      ? { properties: Object.entries(spec.props).map(([name, value]) => ({ name, value: { type: 'value', value } })) }
      : {}),
  };
}

export const BOOKING_TREE: AXNode[] = [
  node({ id: 'n1', backend: NODE.root, role: 'RootWebArea', name: 'Book a room — Ravine Inn', frameId: TOP_FRAME, children: ['n2', 'n14'] }),
  node({ id: 'n2', backend: NODE.main, role: 'main', parent: 'n1', children: ['n3', 'n4', 'n13'] }),
  node({ id: 'n3', backend: NODE.heading, role: 'heading', name: 'Book a room', parent: 'n2', props: { level: 1 } }),
  node({ id: 'n4', backend: NODE.form, role: 'form', name: 'Booking', parent: 'n2', children: ['n5', 'n9', 'n10', 'n11', 'n12'] }),
  node({ id: 'n5', backend: NODE.guests, role: 'combobox', name: 'Guests', value: '2 guests', parent: 'n4', children: ['n6', 'n7', 'n8'] }),
  node({ id: 'n6', backend: NODE.guest1, role: 'option', name: '1 guest', parent: 'n5' }),
  node({ id: 'n7', backend: NODE.guest2, role: 'option', name: '2 guests', parent: 'n5', props: { selected: true } }),
  node({ id: 'n8', backend: NODE.guest3, role: 'option', name: '3 guests', parent: 'n5' }),
  node({ id: 'n9', backend: NODE.dates, role: 'button', name: 'Dates', parent: 'n4', props: { expanded: false, haspopup: 'dialog' } }),
  node({ id: 'n10', backend: NODE.email, role: 'textbox', name: 'Email', parent: 'n4', props: { focused: true, required: true } }),
  node({ id: 'n11', backend: NODE.confirm, role: 'button', name: 'Confirm booking', parent: 'n4' }),
  node({ id: 'n12', backend: NODE.policy, role: 'link', name: 'Cancellation policy', value: 'https://help.ravineinn.com/cancel', parent: 'n4' }),
  node({ id: 'n13', backend: NODE.backToTop, role: 'button', name: 'Back to top', parent: 'n2' }),
  node({ id: 'n14', backend: NODE.payFrame, role: 'Iframe', name: 'Payment', parent: 'n1', children: ['n15'] }),
  node({ id: 'n15', backend: NODE.payRoot, role: 'RootWebArea', name: 'Pay', parent: 'n14', frameId: PAY_FRAME, children: ['n16', 'n17'] }),
  node({ id: 'n16', backend: NODE.cardNumber, role: 'textbox', name: 'Card number', parent: 'n15' }),
  node({ id: 'n17', backend: NODE.pay, role: 'button', name: 'Pay', parent: 'n15' }),
];

/** [backendNodeId, x, y, width, height] in document coordinates, before the scroll offset comes off. */
export const BOXES: Array<[number, number, number, number, number]> = [
  [NODE.main, 0, 0, 800, 1800],
  [NODE.heading, 20, 20, 400, 40],
  [NODE.form, 20, 80, 600, 400],
  [NODE.guests, 20, 100, 300, 32],
  [NODE.dates, 20, 150, 300, 32],
  [NODE.email, 20, 200, 300, 32],
  [NODE.confirm, 20, 250, 200, 40],
  [NODE.policy, 20, 320, 200, 20],
  [NODE.backToTop, 20, 1500, 120, 32],
  [NODE.payFrame, 20, 400, 600, 200],
];

export const HREFS: Array<[number, string]> = [[NODE.policy, 'https://help.ravineinn.com/cancel']];

export const LAYOUT_METRICS = {
  cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 },
  cssContentSize: { width: 800, height: 1800 },
};

/**
 * `DOMSnapshot.captureSnapshot` as Chrome sends it: one string table, and per
 * document a node list with an attribute index and a layout list whose bounds
 * line up with it.
 */
export function domSnapshot(
  scrollY = 0,
  boxes: ReadonlyArray<[number, number, number, number, number]> = BOXES,
  hrefs: ReadonlyArray<[number, string]> = HREFS,
): { documents: unknown[]; strings: string[] } {
  const strings: string[] = ['href'];
  const intern = (s: string): number => {
    const at = strings.indexOf(s);
    if (at >= 0) return at;
    strings.push(s);
    return strings.length - 1;
  };
  const ids = [...new Set([...boxes.map(([id]) => id), ...hrefs.map(([id]) => id)])];
  const hrefBy = new Map(hrefs);
  const attributes = ids.map((id) => (hrefBy.has(id) ? [0, intern(hrefBy.get(id)!)] : []));
  const nodeIndex: number[] = [];
  const bounds: number[][] = [];
  for (const [id, x, y, w, h] of boxes) {
    nodeIndex.push(ids.indexOf(id));
    bounds.push([x, y, w, h]);
  }
  return {
    documents: [{ nodes: { backendNodeId: ids, attributes }, layout: { nodeIndex, bounds }, scrollOffsetX: 0, scrollOffsetY: scrollY }],
    strings,
  };
}

/** Canned replies for one read of the booking page, keyed by CDP method. */
export function bookingReplies(scrollY = 0): Record<string, unknown> {
  return {
    'Accessibility.getFullAXTree': { nodes: BOOKING_TREE },
    'Page.getLayoutMetrics': {
      cssLayoutViewport: { ...LAYOUT_METRICS.cssLayoutViewport, pageY: scrollY },
      cssContentSize: LAYOUT_METRICS.cssContentSize,
    },
    'DOMSnapshot.captureSnapshot': domSnapshot(scrollY),
  };
}
