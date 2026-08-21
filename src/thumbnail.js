'use strict';

const DEFAULT_JPEG_QUALITY = 82;

function hasTransparency(bitmap) {
  if (!Buffer.isBuffer(bitmap) || bitmap.length < 4) return true;
  for (let i = 3; i < bitmap.length; i += 4) {
    if (bitmap[i] !== 255) return true;
  }
  return false;
}

function encodeThumbnail(image, jpegQuality = DEFAULT_JPEG_QUALITY) {
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) {
    return { url: '', width: 0, height: 0 };
  }

  const size = typeof image.getSize === 'function' ? image.getSize() : {};
  const width = Number(size && size.width) || 0;
  const height = Number(size && size.height) || 0;
  let transparent = true;

  try {
    transparent = hasTransparency(image.toBitmap());
  } catch {
    // Preserve alpha when the bitmap cannot be inspected safely.
  }

  let bytes;
  let mime;
  if (!transparent && typeof image.toJPEG === 'function') {
    bytes = image.toJPEG(jpegQuality);
    mime = 'image/jpeg';
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    bytes = image.toPNG();
    mime = 'image/png';
  }

  return {
    url: `data:${mime};base64,${bytes.toString('base64')}`,
    width,
    height,
  };
}

module.exports = {
  DEFAULT_JPEG_QUALITY,
  hasTransparency,
  encodeThumbnail,
};
