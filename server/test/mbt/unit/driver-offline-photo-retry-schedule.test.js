import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(
  path.resolve(HERE, "../../../public/driver-offline-sync.js"),
  "utf8"
);

function sourceSection(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not isolate ${startMarker}.`);
  return SOURCE.slice(start, end);
}

test("retryable photo backoff has an in-page timer fallback", () => {
  assert.match(SOURCE, /const partitionRetryTimers = new Map\(\)/u);
  const scheduler = sourceSection("function schedulePartitionRetry", "async function assertPartitionSession");
  assert.match(scheduler, /nextAttemptAt/u);
  assert.match(scheduler, /setTimeout/u);
  assert.match(scheduler, /syncPartition\(partitionKey\)/u);
  assert.match(scheduler, /clearPartitionRetryTimer/u);

  const failureExit = sourceSection("if (photoFailures.length)", "await global.DriverOfflineDB.cleanupSynced");
  assert.match(failureExit, /schedulePartitionRetry\(partitionKey, photoFailures,[\s\S]*continueDrain:\s*drainInterrupted/u);
  assert.match(failureExit, /error\.photoFailures = photoFailures/u);

  const cancellation = sourceSection("function cancelPartition", "async function syncAll");
  assert.match(cancellation, /clearPartitionRetryTimer\(partitionKey\)/u);
});
