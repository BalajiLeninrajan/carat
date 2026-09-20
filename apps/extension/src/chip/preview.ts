import type { ControlRole, NextAction } from '@carat/shared';
import { truncate } from '@carat/shared';

/**
 * How long the pointer has to rest on a chip before the preview appears. Long
 * enough that a pointer crossing the chip on its way somewhere else never
 * opens it, short enough that someone who stopped to read is not kept waiting.
 */
export const PREVIEW_DELAY_MS = 250;

/** How long the preview line may run before it is clipped. */
export const PREVIEW_CHARS = 80;

/** What the outline said about the control the action names. */
export interface PreviewControl {
  role: ControlRole;
  name: string;
  /** Registrable domain a link goes to. */
  host?: string;
}

export interface PreviewInput {
  action: Pick<NextAction, 'kind' | 'value' | 'source' | 'destination'>;
  /** The control for a fill, click or select; absent for the rest. */
  control?: PreviewControl;
  /** Screens of page left under the fold, for a scroll. */
  below?: number;
}

/**
 * The one line under the chip that says what accepting would actually do:
 * where a tab would land, where a value was read, what a link points at, how
 * much page is left. Everything it needs is already on the action or in the
 * outline, so it costs no request. An empty string means there is nothing
 * worth a second line and the chip stays one.
 */
export function previewLine({ action, control, below }: PreviewInput): string {
  switch (action.kind) {
    case 'open':
    case 'switch':
      return placeLine(action.destination);
    case 'fill':
      return action.source ? truncate(action.source, PREVIEW_CHARS) : '';
    case 'select':
      return control ? `${controlLine(control)} · "${action.value}"` : '';
    case 'click':
      return control ? controlLine(control) : '';
    case 'scroll':
      return below !== undefined && below >= 0.05 ? `${below.toFixed(1)} screens below` : '';
    case 'none':
      return '';
  }
}

/** `maps.google.com · Search: Seven Shores Cafe`, or the host on its own. */
function placeLine(destination: NextAction['destination']): string {
  if (!destination) return '';
  return destination.title ? `${destination.host} · ${destination.title}` : destination.host;
}

/** `link "DoorDash Food Delivery" · doordash.com`; the host only for a link. */
function controlLine(control: PreviewControl): string {
  const named = `${control.role} "${control.name}"`;
  return control.role === 'link' && control.host ? `${named} · ${control.host}` : named;
}

/** Its own stylesheet so the chip's own CSS is left alone. */
export const PREVIEW_CSS = `
.preview {
  font-size: 11px;
  line-height: 1.2;
  color: #a6adc8;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: carat-preview-in 120ms ease-out;
}
.preview[hidden] { display: none; }
.chip.is-armed .preview { color: #4c4f69; }
.chip.is-banner .preview { font-size: 12px; }
@keyframes carat-preview-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .preview { animation: none; }
}
`;
