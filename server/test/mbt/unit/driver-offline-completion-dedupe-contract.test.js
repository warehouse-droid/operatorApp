import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, "../../../public");

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not isolate ${startMarker}.`);
  return source.slice(start, end);
}

test("a second open completion for the same immutable stop is rejected before it can own photos", () => {
  const source = fs.readFileSync(path.join(PUBLIC, "driver-offline-db.js"), "utf8");
  const queueEvent = sourceSection(source, "async function queueEvent", "async function repairEventForSync");
  const duplicateGuard = queueEvent.indexOf("driver_completion_already_saved");
  const photoOwnership = queueEvent.indexOf("const photoIds = []");

  assert.ok(duplicateGuard >= 0, "queueEvent must expose the stable duplicate-completion error code.");
  assert.ok(
    duplicateGuard < photoOwnership,
    "The duplicate guard must run before any draft photo can be rebound to a new event."
  );
  assert.match(queueEvent, /eventType\s*===\s*"job_completed"/u);
  assert.match(queueEvent, /candidate\.eventType\s*===\s*"job_completed"/u);
  assert.match(queueEvent, /candidate\.jobId[\s\S]*input\.jobId/u);
  assert.match(queueEvent, /candidate\.jobFingerprint[\s\S]*input\.jobFingerprint/u);
  assert.match(queueEvent, /eventIsRetainedTerminal\(candidate\)/u);
});
