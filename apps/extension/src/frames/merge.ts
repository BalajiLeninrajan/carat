import type { ElementDescriptor, FieldDescriptor } from '@carat/shared';
import type { ElementEntry, ElementSnapshot } from '../interact';
import { MAX_ELEMENTS, MAX_ELEMENTS_BYTES } from '../interact/enumerate';
import type { FieldEntry, FieldSnapshot } from '../snapshot';
import { MAX_FIELDS, serializeDescriptors, serializeFields } from '../snapshot';
import type { KnownFrame } from './hub';

/** A descriptor that lives in a child frame: the registry element is the frame element, and the child performs. */
export interface FrameRef {
  token: string;
  remoteId: string;
}

export interface MergeInput {
  frame: KnownFrame;
  /** The frame's number for `fr`. */
  num: number;
  /** Per descriptor id, whether its box is inside the top viewport right now. */
  onScreen: (id: string) => boolean;
}

/**
 * The top frame's own fields first, then each child frame's, renumbered to
 * follow on, flagged `fr` and re-marked `o` against the top viewport; the
 * whole list then goes through the same count and byte budget as before, so
 * frame fields are the first to go when the page is busy. Registry entries
 * for frame fields point at the frame element and carry the child's id.
 */
export function mergeFields(own: FieldSnapshot, frames: MergeInput[]): FieldSnapshot {
  const descriptors: FieldDescriptor[] = own.descriptors.map((d) => ({ ...d }));
  const entries: FieldEntry[] = own.descriptors.map((d) => own.registry.get(d.i)!);
  for (const { frame, num, onScreen } of frames) {
    for (const d of frame.report.fields) {
      if (descriptors.length >= MAX_FIELDS) break;
      const id = `f${descriptors.length}`;
      const { o: _o, ...rest } = d;
      descriptors.push({ ...rest, i: id, fr: num, ...(onScreen(d.i) ? {} : { o: 1 as const }) });
      entries.push({ el: frame.iframe, fingerprint: frame.report.fingerprints[d.i] ?? '', frame: { token: frame.token, remoteId: d.i } });
    }
  }
  const kept = serializeFields(descriptors).descriptors;
  const registry = new Map<string, FieldEntry>();
  kept.forEach((d, idx) => registry.set(d.i, entries[idx]!));
  return { descriptors: kept, registry };
}

/** The same for elements, under the element cap and budget. */
export function mergeElements(own: ElementSnapshot, frames: MergeInput[]): ElementSnapshot {
  const descriptors: ElementDescriptor[] = own.descriptors.map((d) => ({ ...d }));
  const entries: ElementEntry[] = own.descriptors.map((d) => own.registry.get(d.i)!);
  for (const { frame, num, onScreen } of frames) {
    for (const d of frame.report.elements) {
      if (descriptors.length >= MAX_ELEMENTS) break;
      const meta = frame.report.entries[d.i];
      if (!meta) continue;
      const id = `e${descriptors.length}`;
      const { o: _o, ...rest } = d;
      descriptors.push({ ...rest, i: id, fr: num, ...(onScreen(d.i) ? {} : { o: 1 as const }) });
      entries.push({
        el: frame.iframe,
        role: meta.role,
        name: meta.name,
        key: `${meta.role}|${meta.name.replace(/\s+/g, ' ').trim().toLowerCase()}`,
        ...(meta.money ? { money: true } : {}),
        frame: { token: frame.token, remoteId: d.i },
      });
    }
  }
  const kept = serializeDescriptors(descriptors, MAX_ELEMENTS_BYTES).descriptors;
  const registry = new Map<string, ElementEntry>();
  kept.forEach((d, idx) => registry.set(d.i, entries[idx]!));
  return { descriptors: kept, registry };
}
