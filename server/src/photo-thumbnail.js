import crypto from "node:crypto";
import sharp from "sharp";

export const PHOTO_THUMBNAIL_MAX_WIDTH = 480;
export const PHOTO_THUMBNAIL_MAX_HEIGHT = 360;
const PHOTO_THUMBNAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const PHOTO_THUMBNAIL_CACHE_MAX_ENTRIES = 256;
const PHOTO_THUMBNAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const photoThumbnailCache = new Map();
let photoThumbnailCacheBytes = 0;

function removeCachedThumbnail(key) {
  const cached = photoThumbnailCache.get(key);
  if (!cached) return;
  photoThumbnailCache.delete(key);
  photoThumbnailCacheBytes = Math.max(0, photoThumbnailCacheBytes - cached.bytes.length);
}

function prunePhotoThumbnailCache(now = Date.now()) {
  for (const [key, cached] of photoThumbnailCache) {
    if (cached.expiresAt > now) continue;
    removeCachedThumbnail(key);
  }
  while (
    photoThumbnailCache.size > PHOTO_THUMBNAIL_CACHE_MAX_ENTRIES
    || photoThumbnailCacheBytes > PHOTO_THUMBNAIL_CACHE_MAX_BYTES
  ) {
    const oldestKey = photoThumbnailCache.keys().next().value;
    if (!oldestKey) break;
    removeCachedThumbnail(oldestKey);
  }
}

export function readCachedPhotoThumbnail(key, now = Date.now()) {
  const cacheKey = String(key || "");
  const cached = photoThumbnailCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    removeCachedThumbnail(cacheKey);
    return null;
  }
  photoThumbnailCache.delete(cacheKey);
  photoThumbnailCache.set(cacheKey, cached);
  return cached;
}

export function cachePhotoThumbnail(key, thumbnail, now = Date.now()) {
  const cacheKey = String(key || "");
  if (!cacheKey || !Buffer.isBuffer(thumbnail?.bytes)) return thumbnail;
  removeCachedThumbnail(cacheKey);
  const cached = {
    ...thumbnail,
    expiresAt: now + PHOTO_THUMBNAIL_CACHE_TTL_MS
  };
  photoThumbnailCache.set(cacheKey, cached);
  photoThumbnailCacheBytes += cached.bytes.length;
  prunePhotoThumbnailCache(now);
  return cached;
}

export async function createPhotoThumbnail(sourceBytes, sourceContentType = "application/octet-stream") {
  const bytes = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes || []);
  if (!bytes.length) throw new Error("Photo thumbnail source is empty.");
  if (!String(sourceContentType || "").toLowerCase().startsWith("image/")) {
    return {
      bytes,
      contentType: sourceContentType || "application/octet-stream",
      byteSize: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      transformed: false
    };
  }

  const resized = await sharp(bytes, {
    failOn: "error",
    limitInputPixels: 40_000_000
  })
    .rotate()
    .resize({
      width: PHOTO_THUMBNAIL_MAX_WIDTH,
      height: PHOTO_THUMBNAIL_MAX_HEIGHT,
      fit: "inside",
      withoutEnlargement: true
    })
    .webp({ quality: 72, effort: 4 })
    .toBuffer();

  const useResized = resized.length < bytes.length;
  const output = useResized ? resized : bytes;
  return {
    bytes: output,
    contentType: useResized ? "image/webp" : sourceContentType,
    byteSize: output.length,
    sha256: crypto.createHash("sha256").update(output).digest("hex"),
    transformed: useResized
  };
}
