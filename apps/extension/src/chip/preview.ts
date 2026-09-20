/**
 * How long the pointer has to rest on a chip before the preview appears. Long
 * enough that a pointer crossing the chip on its way somewhere else never
 * opens it, short enough that someone who stopped to read is not kept waiting.
 */
export const PREVIEW_DELAY_MS = 250;

/** How long the preview line may run before it is clipped. */
export const PREVIEW_CHARS = 80;

/** Its own stylesheet so the chip's own CSS is left alone. */
export const PREVIEW_CSS = `
.preview {
  font-size: 11px;
  line-height: 1.2;
  color: #a6adc8;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: caret-preview-in 120ms ease-out;
}
.preview[hidden] { display: none; }
.chip.is-armed .preview { color: #4c4f69; }
.chip.is-banner .preview { font-size: 12px; }
@keyframes caret-preview-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .preview { animation: none; }
}
`;
