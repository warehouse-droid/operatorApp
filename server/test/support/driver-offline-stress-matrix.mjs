// @ts-check

import history from "../fixtures/driver-offline-stress-history.json" with { type: "json" };

/** @typedef {"fault-cycling" | "stable-drain"} SoakPhase */
/** @typedef {"webkit-mobile" | "chromium-mobile" | "chromium-desktop"} BrowserProject */
/** @typedef {{key: string, label: string, from: number, to: number, count: number}} StressGroup */
/** @typedef {Record<string, string | number | boolean | undefined>} StressConfig */
/**
 * @typedef {{
 *   id: string,
 *   number: number,
 *   group: string,
 *   groupLabel: string,
 *   runtime: "browser" | "node-postgresql",
 *   project: BrowserProject | "node-postgresql",
 *   smoke: boolean,
 *   title: string,
 *   photoCount: number,
 *   config: Readonly<StressConfig>
 * }} StressCase
 */

/** @template T @param {readonly T[]} values @param {number} index @param {string} label @returns {T} */
function requiredValue(values, index, label) {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`${label} index ${index} is outside the declared stress matrix.`);
  }
  return value;
}

export const DEFAULT_STRESS_SEED = 20260812;
export const PHOTO_COUNT_PER_STOP = 8;
export const P99_ROUTE_STOPS = Number(history.observedPercentiles.p99Jobs);
export const P99_ROUTE_PHOTOS = P99_ROUTE_STOPS * PHOTO_COUNT_PER_STOP;

/** @type {readonly StressGroup[]} */
export const STRESS_GROUPS = Object.freeze([
  { key: "historical", label: "Historical WebKit/schema regression", from: 1, to: 32, count: 32 },
  { key: "capture", label: "4K capture and rapid UI races", from: 33, to: 96, count: 64 },
  { key: "network", label: "Network/upload cut points", from: 97, to: 192, count: 96 },
  { key: "quota", label: "Quota/cross-cache pressure", from: 193, to: 240, count: 48 },
  { key: "lifecycle", label: "Lifecycle/concurrency recovery", from: 241, to: 280, count: 40 },
  { key: "server", label: "Server idempotency/durability", from: 281, to: 304, count: 24 },
  { key: "integrity", label: "Recovery/telemetry/harness integrity", from: 305, to: 320, count: 16 }
]);

const SMOKE_IDS = new Set([
  "DOS-001", "DOS-002", "DOS-003", "DOS-004",
  "DOS-033", "DOS-034", "DOS-048", "DOS-064",
  "DOS-097", "DOS-098", "DOS-110", "DOS-128", "DOS-160", "DOS-192",
  "DOS-193", "DOS-200", "DOS-224", "DOS-240",
  "DOS-241", "DOS-252", "DOS-280",
  "DOS-281", "DOS-304", "DOS-320"
]);

const STABLE_DRAIN_IDS = new Set([
  "DOS-097", "DOS-098", "DOS-100", "DOS-101", "DOS-110", "DOS-128",
  "DOS-149", "DOS-160", "DOS-192",
  "DOS-281", "DOS-304", "DOS-320"
]);

/** @type {readonly SoakPhase[]} */
export const SOAK_PHASES = Object.freeze(["fault-cycling", "stable-drain"]);

/** @param {string} phase @param {Record<string, string | undefined>} [environment] */
export function soakCycleEnvironment(phase, environment = {}) {
  if (phase !== "fault-cycling" && phase !== "stable-drain") {
    throw new Error(`Unknown soak phase: ${phase}`);
  }
  const validatedPhase = phase;
  return {
    ...environment,
    DOS_STRESS_SOAK_PHASE: validatedPhase,
    DOS_STRESS_NETWORK_PROFILE: validatedPhase === "stable-drain" ? "stable-online" : "fault-cycling"
  };
}

/** @type {readonly BrowserProject[]} */
const PROJECT_PATTERN = [
  "webkit-mobile",
  "chromium-mobile",
  "webkit-mobile",
  "chromium-desktop",
  "webkit-mobile",
  "chromium-mobile"
];

function browserProjects() {
  /** @type {Record<BrowserProject, number>} */
  const limits = { "webkit-mobile": 144, "chromium-mobile": 88, "chromium-desktop": 48 };
  /** @type {Record<BrowserProject, number>} */
  const counts = { "webkit-mobile": 0, "chromium-mobile": 0, "chromium-desktop": 0 };
  /** @type {BrowserProject[]} */
  const output = [];
  let cursor = 0;
  while (output.length < 280) {
    const project = requiredValue(PROJECT_PATTERN, cursor % PROJECT_PATTERN.length, "Browser project pattern");
    cursor += 1;
    if (counts[project] >= limits[project]) {continue;}
    counts[project] += 1;
    output.push(project);
  }
  return output;
}

const BROWSER_PROJECTS = browserProjects();
const DIMENSIONS = ["3840x2160", "4032x3024"];
const SOURCE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const CAPTURE_BURSTS = [1, 2, 4, 8];
const CAPTURE_ACTIONS = ["confirm", "submit", "next-step", "refresh"];
const NETWORK_CUTS = [
  "registration-before-commit",
  "registration-after-commit",
  "ticket-before-response",
  "upload-zero-bytes",
  "upload-halfway",
  "upload-after-commit",
  "receipt-before-commit",
  "receipt-after-commit"
];
const NETWORK_FAILURES = ["disconnect", "408", "425", "429", "500", "503"];
const NETWORK_WAVEFORMS = ["offline-start", "online-1s-offline-10s"];
const QUOTA_SCENARIOS = [
  "p99-route-capacity",
  "p99-final-stop",
  "adaptive-new-capture",
  "committed-evidence-immutable",
  "optional-cache-evicted-first",
  "cross-partition-headroom",
  "quota-failure-atomicity",
  "browser-estimate-pressure"
];
const QUOTA_LEVELS = [96, 99, 100, 120, 160, 167];
const LIFECYCLE_SCENARIOS = [
  "reload-before-submit",
  "reload-after-submit",
  "renderer-crash-before-submit",
  "renderer-crash-after-submit",
  "two-tab-lease-race",
  "schema-reopen",
  "partition-lock-recovery",
  "device-identity-recovery"
];
const LIFECYCLE_FANOUTS = [1, 2, 4, 8, 20];
const SERVER_SCENARIOS = [
  "exact-replay",
  "lost-response-replay",
  "concurrent-exact-replay",
  "immutable-payload-conflict",
  "device-sequence-conflict",
  "durable-row-count"
];
const SERVER_FANOUTS = [2, 5, 10, 25];
export const MUTANT_NAMES = Object.freeze([
  "blob-persistence",
  "premature-byte-deletion",
  "committed-photo-recompression",
  "missing-click-mutex",
  "changed-replay-payload",
  "skipped-durable-checkpoint",
  "ignored-quota-headroom",
  "lost-sync-lease"
]);
const INTEGRITY_SCENARIOS = [
  ...MUTANT_NAMES.map((name) => `mutation-${name}`),
  "property-network-eventual-convergence",
  "property-durable-bytes-retention",
  "property-sealed-payload-immutability",
  "property-click-idempotency",
  "matrix-cardinality-and-assignment",
  "diagnostic-sanitization",
  "historical-clone-percentiles",
  "evidence-completeness"
];

/** @param {number} number */
function idFor(number) {
  return `DOS-${String(number).padStart(3, "0")}`;
}

/** @param {number} number */
function groupFor(number) {
  return STRESS_GROUPS.find(({ from, to }) => number >= from && number <= to);
}

/** @param {number} index @returns {StressConfig} */
function historicalConfig(index) {
  const storageKinds = ["ArrayBuffer-only", "File", "ArrayBuffer", "mixed"];
  const knownError = requiredValue(history.knownErrors, 0, "Historical error");
  return {
    legacyDbVersion: 1 + (index % 2),
    storageKind: requiredValue(storageKinds, index % storageKinds.length, "Storage kind"),
    sourceDimensions: requiredValue(DIMENSIONS, index % DIMENSIONS.length, "Source dimension"),
    sourceMimeType: requiredValue(SOURCE_MIME_TYPES, index % SOURCE_MIME_TYPES.length, "Source MIME type"),
    injectedIndexedDbFault: index % 8 === 7,
    historicalErrorCode: knownError.code
  };
}

/** @param {number} index @returns {StressConfig} */
function captureConfig(index) {
  return {
    sourceDimensions: requiredValue(DIMENSIONS, index % DIMENSIONS.length, "Source dimension"),
    sourceMimeType: requiredValue(SOURCE_MIME_TYPES, Math.floor(index / 2) % SOURCE_MIME_TYPES.length, "Source MIME type"),
    compressionBurst: requiredValue(CAPTURE_BURSTS, Math.floor(index / 6) % CAPTURE_BURSTS.length, "Capture burst"),
    action: requiredValue(CAPTURE_ACTIONS, Math.floor(index / 24) % CAPTURE_ACTIONS.length, "Capture action"),
    clickRateHz: 20,
    sourcePhotoCount: PHOTO_COUNT_PER_STOP,
    networkAtCapture: index % 2 ? "offline" : "online"
  };
}

/** @param {number} index @returns {StressConfig} */
function networkConfig(index) {
  const cutIndex = index % NETWORK_CUTS.length;
  const failureIndex = Math.floor(index / NETWORK_CUTS.length) % NETWORK_FAILURES.length;
  const waveformIndex = Math.floor(index / (NETWORK_CUTS.length * NETWORK_FAILURES.length));
  return {
    cutPoint: requiredValue(NETWORK_CUTS, cutIndex, "Network cut"),
    failure: requiredValue(NETWORK_FAILURES, failureIndex, "Network failure"),
    waveform: requiredValue(NETWORK_WAVEFORMS, waveformIndex, "Network waveform"),
    sourceDimensions: requiredValue(DIMENSIONS, index % DIMENSIONS.length, "Source dimension"),
    sourceMimeType: requiredValue(SOURCE_MIME_TYPES, index % SOURCE_MIME_TYPES.length, "Source MIME type"),
    sourcePhotoCount: PHOTO_COUNT_PER_STOP,
    virtualizedWaveform: true
  };
}

/** @param {number} index @returns {StressConfig} */
function quotaConfig(index) {
  return {
    scenario: requiredValue(QUOTA_SCENARIOS, index % QUOTA_SCENARIOS.length, "Quota scenario"),
    existingPhotoCount: requiredValue(QUOTA_LEVELS, Math.floor(index / QUOTA_SCENARIOS.length), "Quota level"),
    routeTargetPhotos: P99_ROUTE_PHOTOS,
    sourcePhotoCount: PHOTO_COUNT_PER_STOP,
    pressureTargetBytes: 750 * 1024,
    minimumEdge: 1600,
    minimumQuality: 0.6
  };
}

/** @param {number} index @returns {StressConfig} */
function lifecycleConfig(index) {
  return {
    scenario: requiredValue(LIFECYCLE_SCENARIOS, index % LIFECYCLE_SCENARIOS.length, "Lifecycle scenario"),
    fanout: requiredValue(LIFECYCLE_FANOUTS, Math.floor(index / LIFECYCLE_SCENARIOS.length), "Lifecycle fanout"),
    sourcePhotoCount: PHOTO_COUNT_PER_STOP,
    sourceDimensions: requiredValue(DIMENSIONS, index % DIMENSIONS.length, "Source dimension")
  };
}

/** @param {number} index @returns {StressConfig} */
function serverConfig(index) {
  return {
    scenario: requiredValue(SERVER_SCENARIOS, index % SERVER_SCENARIOS.length, "Server scenario"),
    fanout: requiredValue(SERVER_FANOUTS, Math.floor(index / SERVER_SCENARIOS.length), "Server fanout")
  };
}

/** @param {number} number @param {StressGroup} group @returns {StressConfig} */
function configFor(number, group) {
  const index = number - group.from;
  if (group.key === "historical") {return historicalConfig(index);}
  if (group.key === "capture") {return captureConfig(index);}
  if (group.key === "network") {return networkConfig(index);}
  if (group.key === "quota") {return quotaConfig(index);}
  if (group.key === "lifecycle") {return lifecycleConfig(index);}
  if (group.key === "server") {return serverConfig(index);}
  return { scenario: requiredValue(INTEGRITY_SCENARIOS, index, "Integrity scenario") };
}

/** @param {StressGroup} group @param {StressConfig} config @returns {string} */
function caseTitle(group, config) {
  if (group.key === "historical") {
    return `${config.storageKind} schema-v${config.legacyDbVersion} WebKit migration${config.injectedIndexedDbFault ? " with classified UnknownError injection" : ""}`;
  }
  if (group.key === "capture") {
    return `${config.sourceDimensions} ${config.sourceMimeType} eight-photo ${config.compressionBurst}x burst plus ${config.action} at 20Hz`;
  }
  if (group.key === "network") {return `${config.cutPoint} ${config.failure} under ${config.waveform}`;}
  if (group.key === "quota") {return `${config.scenario} with ${config.existingPhotoCount} retained photos`;}
  if (group.key === "lifecycle") {return `${config.scenario} with ${config.fanout} competing operators/tabs`;}
  if (group.key === "server") {return `${config.scenario} with ${config.fanout} concurrent requests`;}
  return String(config.scenario || "unknown integrity scenario");
}

/** @type {readonly StressCase[]} */
export const DRIVER_OFFLINE_STRESS_CASES = Object.freeze(Array.from({ length: 320 }, (_, offset) => {
  const number = offset + 1;
  const id = idFor(number);
  const group = groupFor(number);
  if (!group) {throw new Error(`No stress group owns ${id}.`);}
  const config = configFor(number, group);
  const runtime = number <= 280 ? "browser" : "node-postgresql";
  return Object.freeze({
    id,
    number,
    group: group.key,
    groupLabel: group.label,
    runtime,
    project: runtime === "browser"
      ? requiredValue(BROWSER_PROJECTS, number - 1, "Browser assignment")
      : "node-postgresql",
    smoke: SMOKE_IDS.has(id),
    title: caseTitle(group, config),
    photoCount: runtime === "browser" ? PHOTO_COUNT_PER_STOP : 0,
    config: Object.freeze(config)
  });
}));

/** @param {readonly StressCase[]} cases @param {string[]} errors */
function validateStressIdentities(cases, errors) {
  const ids = cases.map(({ id }) => id);
  if (cases.length !== 320) {errors.push(`Expected 320 cases, received ${cases.length}.`);}
  if (new Set(ids).size !== cases.length) {errors.push("Case IDs are not unique.");}
  for (let number = 1; number <= 320; number += 1) {
    if (!ids.includes(idFor(number))) {errors.push(`Missing ${idFor(number)}.`);}
  }
}

/** @param {readonly StressCase[]} cases @param {string[]} errors */
function validateStressGroups(cases, errors) {
  for (const group of STRESS_GROUPS) {
    const actual = cases.filter((item) => item.group === group.key).length;
    if (actual !== group.count) {errors.push(`${group.key} expected ${group.count}, received ${actual}.`);}
  }
}

/** @param {readonly StressCase[]} [cases] */
export function validateStressMatrix(cases = DRIVER_OFFLINE_STRESS_CASES) {
  /** @type {string[]} */
  const errors = [];
  validateStressIdentities(cases, errors);
  validateStressGroups(cases, errors);
  const browserCount = cases.filter(({ runtime }) => runtime === "browser").length;
  const nodeCount = cases.filter(({ runtime }) => runtime === "node-postgresql").length;
  if (browserCount !== 280) {errors.push("Expected 280 browser cases.");}
  if (nodeCount !== 40) {errors.push("Expected 40 Node/PostgreSQL cases.");}
  /** @type {Record<BrowserProject, number>} */
  const projectCounts = {
    "webkit-mobile": cases.filter((item) => item.project === "webkit-mobile").length,
    "chromium-mobile": cases.filter((item) => item.project === "chromium-mobile").length,
    "chromium-desktop": cases.filter((item) => item.project === "chromium-desktop").length
  };
  if (projectCounts["webkit-mobile"] !== 144) {errors.push("Expected 144 mobile WebKit cases.");}
  if (projectCounts["chromium-mobile"] !== 88) {errors.push("Expected 88 mobile Chromium cases.");}
  if (projectCounts["chromium-desktop"] !== 48) {errors.push("Expected 48 desktop Chromium cases.");}
  if (cases.filter(({ smoke }) => smoke).length !== 24) {errors.push("Expected 24 smoke cases.");}
  return { valid: errors.length === 0, errors, projectCounts };
}

/** @param {number} seed @returns {() => number} */
function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {readonly StressCase[]} cases @param {number} [seed] @returns {StressCase[]} */
export function shuffledStressCases(cases, seed = DEFAULT_STRESS_SEED) {
  const output = [...cases];
  const random = seededRandom(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const current = requiredValue(output, index, "Shuffle source");
    output[index] = requiredValue(output, target, "Shuffle target");
    output[target] = current;
  }
  return output;
}

/** @param {{mode?: string, caseId?: string, seed?: number}} [options] @returns {StressCase[]} */
export function selectStressCases({ mode = "full", caseId = "", seed = DEFAULT_STRESS_SEED } = {}) {
  const selected = caseId
    ? DRIVER_OFFLINE_STRESS_CASES.filter(({ id }) => id === caseId)
    : mode === "smoke"
      ? DRIVER_OFFLINE_STRESS_CASES.filter(({ smoke }) => smoke)
      : mode === "stable-drain"
        ? DRIVER_OFFLINE_STRESS_CASES.filter(({ id }) => STABLE_DRAIN_IDS.has(id))
      : [...DRIVER_OFFLINE_STRESS_CASES];
  if (caseId && selected.length !== 1) {throw new Error(`Unknown Driver offline stress case: ${caseId}`);}
  if (!caseId && !["smoke", "full", "stable-drain"].includes(mode)) {throw new Error(`Unknown stress mode: ${mode}`);}
  return shuffledStressCases(selected, seed);
}

export function buildHistoricalClone() {
  const dates = Array.from({ length: 13 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 6, 30 + index));
    return date.toISOString().slice(0, 10);
  });
  const jobCounts = history.manifestJobCountDistribution.flatMap(({ jobCount, count }) => (
    Array.from({ length: count }, () => Number(jobCount))
  ));
  return jobCounts.map((jobCount, index) => ({
    manifestAlias: `history-manifest-${String(index + 1).padStart(3, "0")}`,
    planDate: requiredValue(dates, index % dates.length, "Historical plan date"),
    jobCount,
    shape: requiredValue(history.commonShapes, index % history.commonShapes.length, "Historical shape").shape
  }));
}

export { history as ANONYMIZED_HISTORY };
