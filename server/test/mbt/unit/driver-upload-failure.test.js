import assert from "node:assert/strict";
import test from "node:test";
import {pathToFileURL} from "node:url";
import {failure} from "../../support/driver-upload-fixtures.mjs";
const {normalizeUploadFailure} = await import(process.env.DRIVER_UPLOAD_FAILURE_MODULE_FILE ? pathToFileURL(process.env.DRIVER_UPLOAD_FAILURE_MODULE_FILE) : new URL("../../../src/driver-upload-failure.js", import.meta.url));

test("failure normalization keeps only bounded diagnostic fields", () => {
  const normalized = normalizeUploadFailure(failure({driverLogin: "spoof", authorization: "secret", imageDataUrl: "private", message: "x".repeat(3000)}));
  assert.equal(normalized.failureId, failure().failureId);
  assert.equal(normalized.stage, "uploading");
  assert.ok(normalized.message.length <= 1000);
  assert.equal(normalized.driverLogin, undefined);
  assert.equal(normalized.authorization, undefined);
  assert.equal(normalized.imageDataUrl, undefined);
});

test("malformed diagnostics cannot create an audit record", () => {
  for (const value of [failure({failureId: "bad"}), failure({stage: "bad"}), failure({occurredAt: "bad"}), failure({byteSize: -1}), failure({percentage: 101}), failure({httpStatus: 999})]) {
    assert.throws(() => normalizeUploadFailure(value), error => error.status === 400);
  }
});

test("failure normalization strips credential-bearing messages", () => {
  const normalized = normalizeUploadFailure(failure({message: "Bearer secret-value data:image/jpeg;base64,image-secret"}));
  assert.doesNotMatch(normalized.message, /secret-value|image-secret/u);
  const fields = ["jobId", "photoId", "recordType", "clientVersion", "assetVersion", "errorCode"];
  const unsafe = "Bearer synthetic-private-token data:image/jpeg;base64,synthetic-image";
  const metadata = normalizeUploadFailure(failure(Object.fromEntries(fields.map(field => [field, unsafe]))));
  for (const field of fields) assert.doesNotMatch(metadata[field], /synthetic-private-token|synthetic-image/u);
});
