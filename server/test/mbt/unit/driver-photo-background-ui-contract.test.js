import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(
  path.resolve(HERE, "../../../public/driver.js"),
  "utf8"
);

function section(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not isolate ${startMarker}.`);
  return SOURCE.slice(start, end);
}

test("startup photo recovery remains usable while large retained Blobs upload", () => {
  assert.match(
    SOURCE,
    /function retainedPhotoRecoveryRunsInBackground[\s\S]*partitionUnsyncedPhotoCount/u
  );
  const preparation = section(
    "async function prepareQuietSyncHoldForSavedWork",
    "async function triggerOfflineSync"
  );
  assert.match(preparation, /retainedPhotoRecoveryRunsInBackground\(health\)/u);
  assert.match(preparation, /return null/u);

  const login = section('app.addEventListener("submit"', "async function initializeOfflineStorage");
  assert.match(login, /retainedPhotoRecoveryRunsInBackground\(\)/u);
  assert.match(login, /await loadNextJob\(\)/u);
  assert.match(login, /void triggerOfflineSync\(\{ suppressHold: true \}\)/u);

  const init = section("async function init()", 'window.addEventListener("mbbs-language-changed"');
  assert.match(init, /retainedPhotoRecoveryRunsInBackground\(\)/u);
  assert.match(init, /void triggerOfflineSync\(\{ suppressHold: true \}\)/u);
});
