// @ts-check

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { stressSourceState } from "./driver-offline-stress-artifacts.mjs";
import {
  createSoakCheckpoint,
  recordCompletedSoakCycle,
  soakCheckpointPassed,
  soakPhaseForCheckpoint,
  soakSummaryFromCheckpoint,
  validateSoakCheckpoint,
  validateSoakImageReference,
  validateSoakRunId
} from "./driver-offline-soak-state.mjs";
import {
  DEFAULT_STRESS_SEED,
  soakCycleEnvironment
} from "./driver-offline-stress-matrix.mjs";

/** @typedef {ReturnType<typeof createSoakCheckpoint>} SoakCheckpoint */
/** @typedef {"fault-cycling" | "stable-drain"} ActiveSoakPhase */
/**
 * @typedef {{
 *   cycleIndex: number,
 *   attempt: number,
 *   runId: string,
 *   phase: ActiveSoakPhase,
 *   mode: string,
 *   networkProfile: string,
 *   seed: number,
 *   exitCode: number,
 *   signal: string,
 *   durationMs: number,
 *   error?: string
 * }} SoakCycleResult
 */

const hours = Number(process.env.DOS_SOAK_HOURS || 8);
const drainMinutes = Number(process.env.DOS_SOAK_DRAIN_MINUTES || 30);
const segmentMinutesText = String(process.env.DOS_SOAK_SEGMENT_MINUTES || "").trim();
const segmentMinutes = segmentMinutesText ? Number(segmentMinutesText) : 0;
if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(drainMinutes) || drainMinutes < 0) {
  throw new Error("DOS_SOAK_HOURS must be positive and DOS_SOAK_DRAIN_MINUTES must be nonnegative.");
}
if (!Number.isFinite(segmentMinutes) || segmentMinutes < 0) {
  throw new Error("DOS_SOAK_SEGMENT_MINUTES must be nonnegative.");
}

const generatedRunId = `release-${new Date().toISOString()
  .toLowerCase()
  .replaceAll(":", "")
  .replaceAll(".", "-")}`;
const soakRunId = validateSoakRunId(process.env.DOS_SOAK_RUN_ID || generatedRunId);
const runtimeImage = validateSoakImageReference(
  process.env.DOS_SOAK_RUNTIME_IMAGE,
  "DOS_SOAK_RUNTIME_IMAGE"
);
const e2eImage = validateSoakImageReference(
  process.env.DOS_SOAK_E2E_IMAGE,
  "DOS_SOAK_E2E_IMAGE"
);
const summaryDirectory = path.resolve("test-artifacts/driver-offline-stress/soak");
const checkpointPath = path.join(summaryDirectory, `soak-${soakRunId}.checkpoint.json`);
const summaryPath = path.join(summaryDirectory, `soak-${soakRunId}.json`);
await mkdir(summaryDirectory, { recursive: true });
const sourceState = await stressSourceState();

/** @param {SoakCheckpoint} value */
async function atomicWriteCheckpoint(value) {
  const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, checkpointPath);
}

/** @returns {Promise<SoakCheckpoint | null>} */
async function readCheckpoint() {
  try {
    return /** @type {SoakCheckpoint} */ (JSON.parse(await readFile(checkpointPath, "utf8")));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {return null;}
    throw error;
  }
}

let checkpoint = await readCheckpoint();
if (checkpoint) {
  validateSoakCheckpoint(checkpoint, {
    runId: soakRunId,
    requestedHours: hours,
    requestedStableDrainMinutes: drainMinutes,
    sourceDigest: sourceState.digest,
    runtimeImage,
    e2eImage
  });
  if (checkpoint.pendingCycle) {
    throw new Error(
      `Soak ${soakRunId} contains interrupted cycle ${checkpoint.pendingCycle.cycleIndex}; start a new run ID.`
    );
  }
  if (checkpoint.failed) {
    throw new Error(`Soak ${soakRunId} already contains a failed cycle; start a new run ID.`);
  }
} else {
  checkpoint = createSoakCheckpoint({
    runId: soakRunId,
    requestedHours: hours,
    requestedStableDrainMinutes: drainMinutes,
    sourceDigest: sourceState.digest,
    runtimeImage,
    e2eImage
  });
}

if (soakCheckpointPassed(checkpoint)) {
  console.log(`[driver-offline-soak] already complete: ${summaryPath}`);
  process.exit(0);
}

checkpoint.segmentCount += 1;
checkpoint.updatedAt = new Date().toISOString();
await atomicWriteCheckpoint(checkpoint);

/**
 * @param {number} seed
 * @param {ActiveSoakPhase} phase
 * @param {number} cycleIndex
 * @param {number} attempt
 * @param {string} runId
 * @returns {Promise<SoakCycleResult>}
 */
function runCycle(seed, phase, cycleIndex, attempt, runId) {
  return new Promise((resolve) => {
    const cycleStartedAt = Date.now();
    const mode = phase === "stable-drain" ? "stable-drain" : "smoke";
    const cycleEnvironment = soakCycleEnvironment(phase, process.env);
    const child = spawn(process.execPath, ["test/support/run-driver-offline-stress.mjs", mode], {
      cwd: process.cwd(),
      env: {
        ...cycleEnvironment,
        DOS_STRESS_SEED: String(seed),
        DOS_STRESS_RUN_ID_OVERRIDE: runId
      },
      stdio: "inherit"
    });
    let resolved = false;
    /** @param {{exitCode: number, signal: string, error?: string}} result */
    const finish = (result) => {
      if (resolved) {return;}
      resolved = true;
      resolve({
        cycleIndex,
        attempt,
        runId,
        phase,
        mode,
        networkProfile: cycleEnvironment.DOS_STRESS_NETWORK_PROFILE,
        seed,
        durationMs: Date.now() - cycleStartedAt,
        ...result
      });
    };
    child.on("error", (error) => finish({
      exitCode: 1,
      signal: "",
      error: error.message
    }));
    child.on("exit", (code, signal) => finish({
      exitCode: code ?? 1,
      signal: signal || ""
    }));
  });
}

const segmentStartedAt = Date.now();
const segmentDeadline = segmentMinutes > 0
  ? segmentStartedAt + segmentMinutes * 60 * 1000
  : Number.POSITIVE_INFINITY;
let completedThisSegment = 0;

while (!new Set(["complete", "failed"]).has(soakPhaseForCheckpoint(checkpoint))) {
  if (completedThisSegment > 0 && Date.now() >= segmentDeadline) {break;}
  const phase = soakPhaseForCheckpoint(checkpoint);
  if (phase !== "fault-cycling" && phase !== "stable-drain") {break;}
  const cycleIndex = checkpoint.nextCycleIndex;
  const seed = DEFAULT_STRESS_SEED + cycleIndex;
  const attempt = checkpoint.totalAttempts + 1;
  const runId = `soak-${soakRunId}-c${String(cycleIndex).padStart(4, "0")}-a${attempt}`;
  checkpoint.totalAttempts = attempt;
  checkpoint.pendingCycle = {
    cycleIndex,
    attempt,
    runId,
    phase,
    seed,
    startedAt: new Date().toISOString()
  };
  checkpoint.updatedAt = new Date().toISOString();
  await atomicWriteCheckpoint(checkpoint);

  const result = await runCycle(seed, phase, cycleIndex, attempt, runId);
  checkpoint = recordCompletedSoakCycle(checkpoint, result);
  completedThisSegment += 1;
  await atomicWriteCheckpoint(checkpoint);
  if (checkpoint.failed) {break;}
}

const phase = soakPhaseForCheckpoint(checkpoint);
if (phase === "complete" || phase === "failed") {
  const summary = soakSummaryFromCheckpoint(checkpoint);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[driver-offline-soak] summary: ${summaryPath}`);
  if (!summary.passed) {process.exitCode = 1;}
} else {
  console.log(
    `[driver-offline-soak] segment ${checkpoint.segmentCount} complete; `
    + `phase=${phase}; faultCyclingDurationMs=${checkpoint.faultCyclingDurationMs}; `
    + `stableDrainDurationMs=${checkpoint.stableDrainDurationMs}; checkpoint=${checkpointPath}`
  );
}
