import { BasisError, ValidationError } from '../core/errors';

/** Resizes image bytes to `size` x `size` (center-crop) and encodes them at `quality` (0-100): see loadImageResizer. */
export type ImageResizer = (bytes: Uint8Array, size: number, quality: number) => Promise<Uint8Array>;

/** Which build this is: `browser` here, `node` in the Node build. */
export const PLATFORM: 'node' | 'browser' = 'browser';

const noFiles = (): never => {
  throw new ValidationError(
    'queueFile',
    'The sync queue file needs a file system (Node.js only); the browser build of basis-sdk has none. Queued syncs stay ' +
    'in client.pendingSyncs (memory): call client.flushPendingSyncs(), or persist JSON.stringify(client.pendingSyncs) ' +
    'yourself and push the entries back into client.pendingSyncs on the next page load.',
  );
};

/** Not available in the browser: throws ValidationError('queueFile'). */
export function loadFs(): Promise<typeof import('node:fs/promises')> {
  return noFiles();
}

/** Not available in the browser: throws ValidationError('queueFile'). */
export function loadPath(): Promise<typeof import('node:path')> {
  return noFiles();
}

type Canvas2D = {
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
};

/**
 * The image resizer of this build, checked before anything is downloaded: the browser's canvas (OffscreenCanvas, else
 * a <canvas> element) center-crops the image to `size` x `size` and encodes it as WebP at `quality` (the browser
 * decodes it upright by its EXIF orientation). A browser that cannot encode WebP (Safari) returns PNG instead:
 * uploadImage sends the type the bytes have. Throws BasisError when the runtime has no canvas; the resizer throws
 * BasisError when it cannot decode the bytes.
 */
export async function loadImageResizer(): Promise<ImageResizer> {
  const g = globalThis as any;
  if (typeof g.createImageBitmap !== 'function' || (typeof g.OffscreenCanvas !== 'function' && typeof g.document === 'undefined')) {
    throw new BasisError(
      '[basis-sdk] downloadImage / uploadImageFromUrl need a canvas (OffscreenCanvas or document) to resize the image, and ' +
      'this runtime has none. Resize the image yourself (512x512) and call uploadImage() with the bytes.',
    );
  }
  return resizeWithCanvas;
}

async function resizeWithCanvas(bytes: Uint8Array, size: number, quality: number): Promise<Uint8Array> {
  const g = globalThis as any;
  let bitmap: { width: number; height: number; close?: () => void };
  try {
    bitmap = await g.createImageBitmap(new Blob([new Uint8Array(bytes)]));
  } catch (e) {
    throw new BasisError(`[basis-sdk] the browser cannot decode this image: ${(e as Error)?.message ?? e}`);
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = Math.floor((bitmap.width - side) / 2);
    const sy = Math.floor((bitmap.height - side) / 2);
    let blob: Blob;
    if (typeof g.OffscreenCanvas === 'function') {
      const canvas = new g.OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d') as Canvas2D | null;
      if (!ctx) throw new BasisError('[basis-sdk] the browser gave no 2D canvas context to resize the image');
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
      blob = await canvas.convertToBlob({ type: 'image/webp', quality: quality / 100 });
    } else {
      const canvas = g.document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d') as Canvas2D | null;
      if (!ctx) throw new BasisError('[basis-sdk] the browser gave no 2D canvas context to resize the image');
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
      blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (b: Blob | null) => (b ? resolve(b) : reject(new BasisError('[basis-sdk] the browser could not encode the resized image'))),
        'image/webp', quality / 100,
      ));
    }
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close?.();
  }
}
