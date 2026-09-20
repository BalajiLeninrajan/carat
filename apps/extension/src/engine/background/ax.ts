/** CDP accessibility types, and helpers with no chrome.* dependency. */

/** The subset of CDP's Accessibility.AXNode that Caret reads. */
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
}

export function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}
