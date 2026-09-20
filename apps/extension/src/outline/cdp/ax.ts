/** CDP accessibility types, and helpers with no chrome.* dependency. */

/** The subset of CDP's Accessibility.AXNode that Carat reads. */
export interface AXValue {
  type: string;
  value?: unknown;
}
export interface AXProperty {
  name: string;
  value: AXValue;
}
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  /** Carat's addition: set on the root of each frame's tree, and carried down to everything inside it. */
  frameId?: string;
}

export function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}
