import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_SOURCE = fs.readFileSync(
  path.resolve(HERE, "../../../public/driver-offline-db.js"),
  "utf8"
);

test("photo retry phase and schedule survive a page or service-worker restart", () => {
  assert.match(DB_SOURCE, /async function markPhotoAttempt/u);
  assert.match(DB_SOURCE, /attemptCount:\s*Number\(existing\.attemptCount \|\| 0\) \+ 1/u);
  assert.match(DB_SOURCE, /uploadPhase/u);
  assert.match(DB_SOURCE, /lastErrorCode/u);
  assert.match(DB_SOURCE, /lastHttpStatus/u);
  assert.match(DB_SOURCE, /retryable/u);
  assert.match(DB_SOURCE, /nextAttemptAt/u);
  assert.match(DB_SOURCE, /markPhotoAttempt,[\s\S]*markPhotoUploaded,[\s\S]*markPhotoError/u);
});

test("durable confirmation is the only response that clears retry state and the retained photo bytes", () => {
  assert.match(
    DB_SOURCE,
    /const durable = Boolean\([\s\S]*uploadPhase: durable\s*\? "durable"[\s\S]*blobBytes: durable \? null : existing\.blobBytes/u
  );
  assert.match(
    DB_SOURCE,
    /async function markPhotoUploaded[\s\S]*lastErrorCode:\s*""[\s\S]*lastHttpStatus:\s*0[\s\S]*retryable:\s*false/u,
    "A fresh upload must not retain stale error diagnostics from an earlier attempt."
  );
  assert.match(
    DB_SOURCE,
    /const durable = Boolean\([\s\S]*lastErrorCode:\s*durable\s*\?\s*""[\s\S]*lastHttpStatus:\s*durable\s*\?\s*0/u,
    "Durable confirmation must clear stale error code and HTTP status."
  );
  const durablePredicate = DB_SOURCE.slice(
    DB_SOURCE.indexOf("const durable = Boolean("),
    DB_SOURCE.indexOf("const verificationFailed", DB_SOURCE.indexOf("const durable = Boolean("))
  );
  assert.doesNotMatch(
    durablePredicate,
    /status\s*===\s*"received"/u,
    "An ambiguous received status must never clear the only retained photo bytes."
  );
});
