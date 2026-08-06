import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER_SOURCE = fs.readFileSync(
  path.resolve(HERE, "../../../public/driver.js"),
  "utf8"
);

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Could not isolate ${startMarker}.`);
  return source.slice(start, end);
}

test("Driver sync error telemetry includes bounded per-photo diagnostics", () => {
  const report = sourceSection(
    DRIVER_SOURCE,
    "async function reportDriverClientSyncStatus",
    "function quietFinalRefreshSafe"
  );

  assert.match(report, /error\?\.photoFailures/u);
  assert.match(report, /\.slice\(0,\s*10\)/u);
  for (const field of [
    "photoId",
    "eventId",
    "phase",
    "byteSize",
    "attemptCount",
    "retryable",
    "errorCode",
    "httpStatus",
    "message"
  ]) {
    assert.match(report, new RegExp(`\\b${field}\\b`, "u"), `${field} must be reported.`);
  }
});
