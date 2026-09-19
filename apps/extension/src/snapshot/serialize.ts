import type { FieldDescriptor } from '@carat/shared';

export const MAX_FIELDS_BYTES = 2048;

const encoder = new TextEncoder();

/**
 * JSON for the descriptor list, dropping the lowest ranked (last) entries
 * until it fits in `MAX_FIELDS_BYTES`. Returns the kept descriptors too so the
 * caller can trim its registry to match.
 */
export function serializeFields(
  descriptors: FieldDescriptor[],
  maxBytes: number = MAX_FIELDS_BYTES,
): { json: string; descriptors: FieldDescriptor[] } {
  const kept = descriptors.slice();
  let json = JSON.stringify(kept);
  while (kept.length > 0 && encoder.encode(json).byteLength > maxBytes) {
    kept.pop();
    json = JSON.stringify(kept);
  }
  return { json, descriptors: kept };
}
