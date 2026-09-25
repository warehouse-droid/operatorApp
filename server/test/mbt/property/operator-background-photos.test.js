import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import fc from "fast-check";
import { validateBackgroundPhotoManifest, isBackgroundPhotoReference } from "../../../src/operator-background-photos.js";
import { closeDb } from "../../../src/db.js";
after(closeDb);
test("manifest normalization preserves order and immutable identity at both size bounds", () => {
  fc.assert(fc.property(fc.array(fc.record({ byteSize: fc.integer({ min: 1, max: 10 * 1024 * 1024 }),
    mimeType: fc.constantFrom("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif") }), { minLength: 2, maxLength: 20 }), values => {
    const photos = values.map(value => ({ ...value, id: crypto.randomUUID(), sha256: "a".repeat(64) }));
    const total = photos.reduce((sum, photo) => sum + photo.byteSize, 0);
    if (total > 16 * 1024 * 1024) assert.throws(() => validateBackgroundPhotoManifest(photos), { status: 400 });
    else {
      assert.deepEqual(validateBackgroundPhotoManifest(photos), photos);
      assert.deepEqual(validateBackgroundPhotoManifest(JSON.parse(JSON.stringify(photos))), photos);
    }
    for (const photo of photos) {
      assert.equal(isBackgroundPhotoReference(`operator-photo://${photo.id}`), true);
      assert.equal(isBackgroundPhotoReference(`operator-photo://${photo.id}/../other`), false);
    }
  }), { seed: 20260917, numRuns: 100 });
});
