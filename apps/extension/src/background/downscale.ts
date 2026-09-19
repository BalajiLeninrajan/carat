/** The two globals the service worker needs to resize an image; injectable so tests can fake them. */
export interface ImageEnv {
  createImageBitmap?: (blob: Blob) => Promise<ImageBitmap>;
  OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas;
}

export const MAX_EDGE = 1024;
export const JPEG_QUALITY = 0.7;

/**
 * Shrinks a captureVisibleTab data URL to at most 1024px on its long edge,
 * re-encoded as JPEG: fewer bytes to hold in session storage and to send, and
 * still enough for a model to read UI text at "low" detail. Where the canvas
 * APIs are missing (jsdom, older runtimes) the image passes through as is.
 */
export async function downscale(
  dataUrl: string,
  env: ImageEnv = globalThis as ImageEnv,
  maxEdge: number = MAX_EDGE,
): Promise<string> {
  if (typeof env.createImageBitmap !== 'function' || typeof env.OffscreenCanvas !== 'function') return dataUrl;
  const source = dataUrlToBlob(dataUrl);
  if (!source) return dataUrl;
  const bitmap = await env.createImageBitmap(source);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height, 1));
    if (scale === 1 && source.type === 'image/jpeg') return dataUrl;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new env.OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return blobToDataUrl(out);
  } finally {
    bitmap.close();
  }
}

function dataUrlToBlob(dataUrl: string): Blob | undefined {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m || !m[2]) return undefined;
  const bytes = Uint8Array.from(atob(m[3]!), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: m[1] ?? 'application/octet-stream' });
}

// FileReader exists in workers as well as windows, and does the base64 itself.
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
