import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const artifactPath = path.resolve(process.argv[2]
  || "test-artifacts/dispatch-planner-replay/two-week-2026-08-05_2026-08-18.json");
const report = JSON.parse(await readFile(artifactPath, "utf8"));

assert.equal(report.projectionComparisons, report.eventsProcessed,
  "Every historical event must produce a projection comparison.");
assert.equal(report.mismatchCount, 0, "Historical replay must have no legacy/optimized projection mismatch.");
assert.ok(report.eventsProcessed >= 1_000, "Replay artifact must contain a material historical sample.");
assert.ok(report.planStateTransitions > 0, "Replay artifact must contain saved-plan transitions.");
assert.ok(report.crossStreamTransitions > 0, "Replay artifact must contain cross-system transitions.");
for (const stream of ["dispatch", "scm", "netsuite", "driver"]) {
  assert.ok(Number(report.streamCounts?.[stream] || 0) > 0, `Replay artifact is missing ${stream} evidence.`);
}
assert.equal(report.gapCount, report.gapSamples.length,
  "Every source-evidence gap in this bounded artifact must remain explicit.");
assert.ok(Array.isArray(report.historicalInteractionGaps), "Historical interaction gaps must be explicit.");
assert.match(String(report.causalDigest || ""), /^[a-f0-9]{64}$/u);
assert.deepEqual(report.privacy, {
  identifiers: "sha256-pseudonymized",
  names: "excluded",
  addresses: "excluded",
  photos: "excluded",
  rawPayloads: "excluded"
});
assert.ok(Object.values(report.assertions || {}).every((value) => value === true),
  "The generated replay assertions must all pass.");

console.log(JSON.stringify({
  artifact: artifactPath,
  eventsProcessed: report.eventsProcessed,
  projectionComparisons: report.projectionComparisons,
  mismatchCount: report.mismatchCount,
  historicalInteractionGaps: report.historicalInteractionGaps,
  causalDigest: report.causalDigest
}));
