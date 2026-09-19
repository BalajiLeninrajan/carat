import type { NextAction, NextActionRequest, OutlineControl } from '@carat/shared';
import { scrollLabel } from '@carat/shared';
import { localAction } from '@carat/providers';

/**
 * What the last resort is worth. Above the eager floor and below anything the
 * model or the regex placeholder would claim, so it never outranks a real
 * answer: it only ever stands where there would otherwise be no chip at all.
 */
export const LAST_RESORT_CONFIDENCE = 0.4;

/** Controls a Tab can press. */
const PRESS_ROLES = new Set(['button', 'link', 'tab', 'menuitem']);

/**
 * The plainest step the page itself offers, for when the model has answered
 * with nothing twice and eager still owes the user a chip. There are no
 * page-kind priors in here and no guesses about what the page is for: read on
 * if there is more page, else put what the user read into the field in front
 * of them, else press the control they would reach for first.
 *
 * Anything this returns still goes through `validate`, so a disabled control,
 * a scroll with nothing below or a field filled with its own name is refused
 * here like anywhere else.
 */
export function lastResort(req: NextActionRequest): NextAction | null {
  if (req.page.scroll.more) {
    return {
      kind: 'scroll',
      target: null,
      value: '',
      label: scrollLabel(req.page.scroll),
      irreversible: false,
      confidence: LAST_RESORT_CONFIDENCE,
      reason: 'nothing else was offered and there is more page below',
    };
  }
  // The regex pass over the notes, matched to the focused text control or the
  // first empty one: a value the user actually read, not one invented here.
  const fill = req.notes.length > 0 ? localAction(req) : null;
  if (fill && fill.kind === 'fill') return { ...fill, confidence: LAST_RESORT_CONFIDENCE, reason: `${fill.reason}; nothing else was offered` };

  const press = primaryControl(req);
  if (!press) return null;
  return {
    kind: 'click',
    target: press.n,
    value: '',
    label: `Click "${press.name}"`,
    irreversible: false,
    confidence: LAST_RESORT_CONFIDENCE,
    reason: 'nothing else was offered; this is the control nearest the focus',
  };
}

/**
 * The control the user would reach for: the focused one when it can be
 * pressed, else the first pressable one the outline listed, which is the one
 * nearest the focus because the outline is trimmed by distance from it. A
 * control the page flagged risky is never the one carat falls back to — a
 * chip that pays is worth a deliberate answer, not a stand-in.
 */
function primaryControl(req: NextActionRequest): OutlineControl | undefined {
  const usable = (c: OutlineControl): boolean =>
    PRESS_ROLES.has(c.role) && c.risky !== true && !/\bdisabled\b/.test(c.state ?? '');
  const focused = req.controls.find((c) => c.n === req.focused);
  if (focused && usable(focused)) return focused;
  return req.controls.find(usable);
}
