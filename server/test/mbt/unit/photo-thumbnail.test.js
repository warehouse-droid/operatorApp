import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  cachePhotoThumbnail,
  createPhotoThumbnail,
  PHOTO_THUMBNAIL_MAX_HEIGHT,
  PHOTO_THUMBNAIL_MAX_WIDTH,
  readCachedPhotoThumbnail
} from "../../../src/photo-thumbnail.js";

test("photo thumbnails are bounded, smaller, and cached separately from full-size proof", async () => {
  const width = 1200;
  const height = 900;
  const raw = Buffer.alloc(width * height * 3);
  let value = 17;
  for (let index = 0; index < raw.length; index += 1) {
    value = ((value * 1103515245) + 12345) & 0x7fffffff;
    raw[index] = value & 0xff;
  }
  const original = await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();

  const thumbnail = await createPhotoThumbnail(original, "image/jpeg");
  const metadata = await sharp(thumbnail.bytes).metadata();

  assert.equal(thumbnail.transformed, true);
  assert.equal(thumbnail.contentType, "image/webp");
  assert.ok(thumbnail.byteSize < original.length);
  assert.ok(metadata.width <= PHOTO_THUMBNAIL_MAX_WIDTH);
  assert.ok(metadata.height <= PHOTO_THUMBNAIL_MAX_HEIGHT);

  cachePhotoThumbnail("r2://test/thumbnail.jpg", thumbnail, 1000);
  assert.equal(readCachedPhotoThumbnail("r2://test/thumbnail.jpg", 1001)?.sha256, thumbnail.sha256);
  assert.equal(readCachedPhotoThumbnail("r2://test/thumbnail.jpg", 301001), null);
});

test("non-image preview data is returned unchanged", async () => {
  const source = Buffer.from("not-an-image");
  const result = await createPhotoThumbnail(source, "application/pdf");
  assert.equal(result.transformed, false);
  assert.equal(result.contentType, "application/pdf");
  assert.deepEqual(result.bytes, source);
});
