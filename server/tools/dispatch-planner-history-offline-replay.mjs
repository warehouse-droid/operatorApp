import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildDispatchHistoricalReplayArtifact } from "../src/dispatch-planner-replay.js";

if (process.env.MBT_TEST_ISOLATED !== "1") {
  throw new Error("Dispatch history replay requires MBT_TEST_ISOLATED=1 and a disposable test environment.");
}

const input = path.resolve(process.argv[2]
  || "test-artifacts/dispatch-planner-replay/seven-day-capture.json");
const output = path.resolve(process.argv[3]
  || "test-artifacts/dispatch-planner-replay/seven-day-report.json");
const expectedLocalDayCount = Number(process.argv[4] || 7);
const capture = JSON.parse(await readFile(input, "utf8"));
const report = buildDispatchHistoricalReplayArtifact({ capture, expectedLocalDayCount });

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (Object.values(report.assertions).some((passed) => passed !== true)) {
  throw new Error(`Dispatch historical replay failed: ${JSON.stringify(report.assertions)}`);
}

process.stdout.write(`${JSON.stringify({
  input,
  output,
  localDayCount: report.window.localDayCount,
  sourceRecordCount: report.captureValidation.sourceRecordCount,
  eventsProcessed: report.eventsProcessed,
  projectionComparisons: report.projectionComparisons,
  mismatchCount: report.mismatchCount,
  gapCount: report.gapCount,
  interactionCoverage: report.interactionCoverage,
  historicalInteractionGaps: report.historicalInteractionGaps,
  captureDigest: report.captureDigest,
  causalDigest: report.causalDigest
})}\n`);
