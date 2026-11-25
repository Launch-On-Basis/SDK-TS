import { BasisError } from '../core/errors';

/** Resizes image bytes to `size` x `size` (center-crop) and encodes them at `quality` (0-100): see loadImageResizer. */
export type ImageResizer = (bytes: Uint8Array, size: number, quality: number) => Promise<Uint8Array>;

/** Which build this is: `node` here, `browser` in the browser build. */
export const PLATFORM: 'node' | 'browser' = 'node';

/** `node:fs/promises` (the sync queue file). */
export function loadFs(): Promise<typeof import('node:fs/promises')> {
  return import('node:fs/promises');
}

/** `node:path` (the sync queue file). */
export function loadPath(): Promise<typeof import('node:path')> {
  return import('node:path');
}

/**
 * The image resizer of this build, loaded before anything is downloaded: with the optional `sharp` package, it turns
 * the image upright by its EXIF orientation (as a browser shows it), center-crops it to `size` x `size` and encodes it
 * as WebP at `quality`. Throws BasisError when sharp is not installed; bytes sharp cannot read throw its error.
 */
export async function loadImageResizer(): Promise<ImageResizer> {
  let sharp: any;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw new BasisError(
      '[basis-sdk] downloadImage / uploadImageFromUrl need the "sharp" package in Node.js (npm install sharp). ' +
      'Or resize the image yourself and call uploadImage() with the bytes.',
    );
  }
  const resize: ImageResizer = async (bytes, size, quality) => {
    const out: Uint8Array = await sharp(Buffer.from(bytes))
      .rotate()
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .webp({ quality })
      .toBuffer();
    return new Uint8Array(out);
  };
  return resize;
}
