// @ts-check

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const IMMUTABLE_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u;

/** @typedef {"fault-cycling" | "stable-drain"} ActiveSoakPhase */
/** @typedef {ActiveSoakPhase | "complete" | "failed"} SoakPhase */
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
/** @typedef {SoakCycleResult & {finishedAt: string}} CompletedSoakCycle */
/**
 * @typedef {{
 *   cycleIndex: number,
 *   attempt: number,
 *   runId: string,
 *   phase: SoakPhase,
 *   seed: number,
 *   startedAt: string
 * }} PendingSoakCycle
 */
/**
 * @typedef {{
 *   schemaVersion: 3,
 *   runId: string,
 *   sourceDigest: string,
 *   runtimeImage: string,
 *   e2eImage: string,
 *   requestedHours: number,
 *   requestedStableDrainMinutes: number,
 *   targetFaultCyclingDurationMs: number,
 *   targetStableDrainDurationMs: number,
 *   createdAt: string,
 *   updatedAt: string,
 *   segmentCount: number,
 *   nextCycleIndex: number,
 *   totalAttempts: number,
 *   faultCyclingDurationMs: number,
 *   stableDrainDurationMs: number,
 *   failed: boolean,
 *   pendingCycle: PendingSoakCycle | null,
 *   interruptions: unknown[],
 *   cycles: CompletedSoakCycle[]
 * }} SoakCheckpoint
 */

/** @param {unknown} value @param {string} label */
function positiveFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be positive.`);
  }
  return number;
}

/** @param {unknown} value @param {string} label */
function nonnegativeFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be nonnegative.`);
  }
  return number;
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return /** @type {T} */ (JSON.parse(JSON.stringify(value)));
}

/** @param {unknown} value */
export function validateSoakRunId(value) {
  const runId = String(value || "").trim();
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("DOS_SOAK_RUN_ID must contain only lowercase letters, digits, dots, underscores, or hyphens.");
  }
  return runId;
}

/** @param {unknown} value @param {string} label */
export function validateSoakImageReference(value, label) {
  const reference = String(value || "").trim();
  if (!IMMUTABLE_IMAGE_PATTERN.test(reference)) {
    throw new Error(`${label} must be an immutable repository@sha256 image reference.`);
  }
  return reference;
}

/**
 * @param {{
 *   runId: unknown,
 *   requestedHours: unknown,
 *   requestedStableDrainMinutes: unknown,
 *   sourceDigest: unknown,
 *   runtimeImage: unknown,
 *   e2eImage: unknown,
 *   now?: number
 * }} input
 * @returns {SoakCheckpoint}
 */
export function createSoakCheckpoint({
  runId,
  requestedHours,
  requestedStableDrainMinutes,
  sourceDigest,
  runtimeImage,
  e2eImage,
  now = Date.now()
}) {
  const hours = positiveFinite(requestedHours, "DOS_SOAK_HOURS");
  const drainMinutes = nonnegativeFinite(
    requestedStableDrainMinutes,
    "DOS_SOAK_DRAIN_MINUTES"
  );
  const digest = String(sourceDigest || "").trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error("The soak source digest must be a lowercase SHA-256 value.");
  }
  return {
    schemaVersion: 3,
    runId: validateSoakRunId(runId),
    sourceDigest: digest,
    runtimeImage: validateSoakImageReference(runtimeImage, "DOS_SOAK_RUNTIME_IMAGE"),
    e2eImage: validateSoakImageReference(e2eImage, "DOS_SOAK_E2E_IMAGE"),
    requestedHours: hours,
    requestedStableDrainMinutes: drainMinutes,
    targetFaultCyclingDurationMs: hours * 60 * 60 * 1000,
    targetStableDrainDurationMs: drainMinutes * 60 * 1000,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    segmentCount: 0,
    nextCycleIndex: 0,
    totalAttempts: 0,
    faultCyclingDurationMs: 0,
    stableDrainDurationMs: 0,
    failed: false,
    pendingCycle: null,
    interruptions: [],
    cycles: []
  };
}

/**
 * @param {SoakCheckpoint} checkpoint
 * @param {{
 *   runId: unknown,
 *   requestedHours: unknown,
 *   requestedStableDrainMinutes: unknown,
 *   sourceDigest: unknown,
 *   runtimeImage: unknown,
 *   e2eImage: unknown
 * }} expected
 * @returns {SoakCheckpoint}
 */
export function validateSoakCheckpoint(checkpoint, {
  runId,
  requestedHours,
  requestedStableDrainMinutes,
  sourceDigest,
  runtimeImage,
  e2eImage
}) {
  if (!checkpoint || checkpoint.schemaVersion !== 3) {
    throw new Error("The soak checkpoint schema is invalid.");
  }
  if (checkpoint.runId !== validateSoakRunId(runId)) {
    throw new Error("The soak checkpoint run ID changed.");
  }
  if (checkpoint.requestedHours !== Number(requestedHours)) {
    throw new Error("The requested soak hours changed while resuming.");
  }
  if (checkpoint.requestedStableDrainMinutes !== Number(requestedStableDrainMinutes)) {
    throw new Error("The requested stable-drain minutes changed while resuming.");
  }
  if (checkpoint.sourceDigest !== String(sourceDigest || "").trim()) {
    throw new Error("The Driver stress source digest changed while resuming the soak.");
  }
  if (checkpoint.runtimeImage !== validateSoakImageReference(runtimeImage, "DOS_SOAK_RUNTIME_IMAGE")) {
    throw new Error("The release soak runtime image changed while resuming.");
  }
  if (checkpoint.e2eImage !== validateSoakImageReference(e2eImage, "DOS_SOAK_E2E_IMAGE")) {
    throw new Error("The release soak E2E image changed while resuming.");
  }
  if (!Array.isArray(checkpoint.cycles) || !Array.isArray(checkpoint.interruptions)) {
    throw new Error("The soak checkpoint cycle history is invalid.");
  }
  return checkpoint;
}

/** @param {SoakCheckpoint} checkpoint @returns {SoakPhase} */
export function soakPhaseForCheckpoint(checkpoint) {
  if (checkpoint.failed) {return "failed";}
  if (checkpoint.faultCyclingDurationMs < checkpoint.targetFaultCyclingDurationMs) {
    return "fault-cycling";
  }
  if (checkpoint.stableDrainDurationMs < checkpoint.targetStableDrainDurationMs) {
    return "stable-drain";
  }
  return "complete";
}

/** @param {SoakCycleResult} result @param {ActiveSoakPhase} expectedPhase */
function validateCycleProfile(result, expectedPhase) {
  if (result.phase !== expectedPhase) {
    throw new Error(`Expected ${expectedPhase} but received ${result.phase}.`);
  }
  if (
    expectedPhase === "fault-cycling"
    && (result.mode !== "smoke" || result.networkProfile !== "fault-cycling")
  ) {
    throw new Error("A fault cycle must use smoke mode and the fault-cycling profile.");
  }
  if (
    expectedPhase === "stable-drain"
    && (result.mode !== "stable-drain" || result.networkProfile !== "stable-online")
  ) {
    throw new Error("A stable drain cycle must use stable-drain mode and the stable-online profile.");
  }
}

/** @param {SoakCheckpoint} checkpoint @param {SoakCycleResult} result @param {number} [now] @returns {SoakCheckpoint} */
export function recordCompletedSoakCycle(checkpoint, result, now = Date.now()) {
  const next = clone(checkpoint);
  const expectedPhase = soakPhaseForCheckpoint(next);
  if (expectedPhase !== "fault-cycling" && expectedPhase !== "stable-drain") {
    throw new Error(`Cannot record a cycle while the soak is ${expectedPhase}.`);
  }
  validateCycleProfile(result, expectedPhase);
  if (result.cycleIndex !== next.nextCycleIndex) {
    throw new Error(`Expected soak cycle ${next.nextCycleIndex}, received ${result.cycleIndex}.`);
  }
  const durationMs = positiveFinite(result.durationMs, "Soak cycle duration");
  /** @type {CompletedSoakCycle} */
  const sanitized = {
    cycleIndex: result.cycleIndex,
    attempt: Number(result.attempt || 0),
    runId: String(result.runId || ""),
    phase: result.phase,
    mode: result.mode,
    networkProfile: result.networkProfile,
    seed: Number(result.seed),
    exitCode: Number(result.exitCode),
    signal: String(result.signal || ""),
    durationMs,
    finishedAt: new Date(now).toISOString(),
    ...(result.error ? { error: String(result.error) } : {})
  };
  next.cycles.push(sanitized);
  next.nextCycleIndex += 1;
  next.pendingCycle = null;
  next.updatedAt = new Date(now).toISOString();
  if (sanitized.exitCode !== 0 || sanitized.signal) {
    next.failed = true;
  } else if (result.phase === "fault-cycling") {
    next.faultCyclingDurationMs += durationMs;
  } else {
    next.stableDrainDurationMs += durationMs;
  }
  return next;
}

/** @param {SoakCheckpoint} checkpoint */
export function soakCheckpointPassed(checkpoint) {
  return soakPhaseForCheckpoint(checkpoint) === "complete"
    && checkpoint.cycles.length > 0
    && checkpoint.interruptions.length === 0
    && checkpoint.cycles.every(({ exitCode, signal }) => exitCode === 0 && !signal)
    && checkpoint.cycles.some(({ phase }) => phase === "fault-cycling")
    && (
      checkpoint.targetStableDrainDurationMs === 0
      || checkpoint.cycles.some(({ phase }) => phase === "stable-drain")
    );
}

/** @param {SoakCheckpoint} checkpoint @param {number} [now] */
export function soakSummaryFromCheckpoint(checkpoint, now = Date.now()) {
  const finishedAt = new Date(now).toISOString();
  return {
    ...clone(checkpoint),
    finishedAt,
    durationMs: now - Date.parse(checkpoint.createdAt),
    activeDurationMs: checkpoint.faultCyclingDurationMs + checkpoint.stableDrainDurationMs,
    faultCyclingCycles: checkpoint.cycles.filter(({ phase }) => phase === "fault-cycling").length,
    stableDrainCycles: checkpoint.cycles.filter(({ phase }) => phase === "stable-drain").length,
    passed: soakCheckpointPassed(checkpoint)
  };
}
