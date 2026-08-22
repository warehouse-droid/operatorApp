import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import fc from "fast-check";

import { sanitizeStressResults } from "../../support/driver-offline-stress-artifacts.mjs";
import {
  createSoakCheckpoint,
  recordCompletedSoakCycle,
  soakCheckpointPassed,
  soakPhaseForCheckpoint,
  validateSoakCheckpoint
} from "../../support/driver-offline-soak-state.mjs";
import {
  ANONYMIZED_HISTORY,
  buildHistoricalClone,
  DEFAULT_STRESS_SEED,
  DRIVER_OFFLINE_STRESS_CASES,
  MUTANT_NAMES,
  P99_ROUTE_PHOTOS,
  selectStressCases,
  soakCycleEnvironment,
  SOAK_PHASES,
  shuffledStressCases,
  validateStressMatrix
} from "../../support/driver-offline-stress-matrix.mjs";
import {
  acquireLease,
  admissionAllowed,
  adaptiveCapturePolicy,
  createLedger,
  markDurable,
  mutationProbe,
  persistPhoto,
  PRESSURE_CAPTURE_POLICY,
  recompressPhoto,
  registerLogicalClick,
  replayEvent,
  sanitizeDiagnostic,
  stableJson,
  uploadPhoto,
  verifyLedger
} from "../../support/driver-offline-stress-model.mjs";

test("Driver offline stress matrix contains exactly 320 contiguous, uniquely assigned cases", () => {
  const validation = validateStressMatrix();
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.deepEqual(validation.projectCounts, {
    "webkit-mobile": 144,
    "chromium-mobile": 88,
    "chromium-desktop": 48
  });
});

test("Driver offline smoke selection contains exactly 24 critical cases", () => {
  assert.equal(selectStressCases({ mode: "smoke" }).length, 24);
});

test("stable drain is an explicit continuously-online no-fault execution profile", () => {
  assert.deepEqual(SOAK_PHASES, ["fault-cycling", "stable-drain"]);
  assert.deepEqual(soakCycleEnvironment("fault-cycling", { RETAINED: "yes" }), {
    RETAINED: "yes",
    DOS_STRESS_SOAK_PHASE: "fault-cycling",
    DOS_STRESS_NETWORK_PROFILE: "fault-cycling"
  });
  assert.deepEqual(soakCycleEnvironment("stable-drain", { RETAINED: "yes" }), {
    RETAINED: "yes",
    DOS_STRESS_SOAK_PHASE: "stable-drain",
    DOS_STRESS_NETWORK_PROFILE: "stable-online"
  });
  assert.throws(() => soakCycleEnvironment("label-only"), /Unknown soak phase/u);

  const drainCases = selectStressCases({ mode: "stable-drain" });
  assert.equal(drainCases.length, 12);
  assert.deepEqual(
    Object.fromEntries(["webkit-mobile", "chromium-mobile", "chromium-desktop", "node-postgresql"].map((project) => [
      project,
      drainCases.filter((item) => item.project === project).length
    ])),
    {
      "webkit-mobile": 3,
      "chromium-mobile": 4,
      "chromium-desktop": 2,
      "node-postgresql": 3
    }
  );
  assert.ok(drainCases.every(({ group }) => ["network", "server", "integrity"].includes(group)));

  const soakSource = readFileSync(
    new URL("../../support/run-driver-offline-soak.mjs", import.meta.url),
    "utf8"
  );
  const browserSource = readFileSync(
    new URL("../../driver-offline-stress/browser.spec.js", import.meta.url),
    "utf8"
  );
  const artifactsSource = readFileSync(
    new URL("../../support/driver-offline-stress-artifacts.mjs", import.meta.url),
    "utf8"
  );
  assert.match(soakSource, /soakCycleEnvironment\(phase, process\.env\)/u);
  assert.match(soakSource, /phase === "stable-drain" \? "stable-drain" : "smoke"/u);
  assert.match(browserSource, /DOS_STRESS_NETWORK_PROFILE/u);
  assert.match(browserSource, /networkProfile === "stable-online"/u);
  assert.match(browserSource, /expect\(convergence\.firstFailure\)\.toBeNull\(\)/u);
  assert.match(artifactsSource, /DOS_STRESS_SOAK_PHASE/u);
  assert.match(artifactsSource, /DOS_STRESS_NETWORK_PROFILE/u);
});

test("segmented soak checkpoints require full active fault and drain time without source changes", () => {
  const runtimeImage = `mbbs-driver-offline-release-runtime@sha256:${"1".repeat(64)}`;
  const e2eImage = `mbbs-driver-offline-release-e2e@sha256:${"2".repeat(64)}`;
  const checkpoint = createSoakCheckpoint({
    runId: "release-v3-v27",
    requestedHours: 1 / 3600,
    requestedStableDrainMinutes: 1 / 60,
    sourceDigest: "a".repeat(64),
    runtimeImage,
    e2eImage,
    now: 1_000
  });
  assert.equal(checkpoint.runtimeImage, runtimeImage);
  assert.equal(checkpoint.e2eImage, e2eImage);
  assert.equal(soakPhaseForCheckpoint(checkpoint), "fault-cycling");
  assert.equal(soakCheckpointPassed(checkpoint), false);
  assert.doesNotThrow(() => validateSoakCheckpoint(checkpoint, {
    runId: "release-v3-v27",
    requestedHours: 1 / 3600,
    requestedStableDrainMinutes: 1 / 60,
    sourceDigest: "a".repeat(64),
    runtimeImage,
    e2eImage
  }));
  assert.throws(() => validateSoakCheckpoint(checkpoint, {
    runId: "release-v3-v27",
    requestedHours: 1 / 3600,
    requestedStableDrainMinutes: 1 / 60,
    sourceDigest: "b".repeat(64),
    runtimeImage,
    e2eImage
  }), /source digest changed/u);
  assert.throws(() => validateSoakCheckpoint(checkpoint, {
    runId: "release-v3-v27",
    requestedHours: 1 / 3600,
    requestedStableDrainMinutes: 1 / 60,
    sourceDigest: "a".repeat(64),
    runtimeImage: `mbbs-driver-offline-release-runtime@sha256:${"3".repeat(64)}`,
    e2eImage
  }), /runtime image changed/u);

  const afterFault = recordCompletedSoakCycle(checkpoint, {
    cycleIndex: 0,
    attempt: 1,
    runId: "fault-cycle",
    phase: "fault-cycling",
    mode: "smoke",
    networkProfile: "fault-cycling",
    seed: DEFAULT_STRESS_SEED,
    exitCode: 0,
    signal: "",
    durationMs: 1_001
  }, 2_001);
  assert.equal(soakPhaseForCheckpoint(afterFault), "stable-drain");
  assert.equal(soakCheckpointPassed(afterFault), false);

  const complete = recordCompletedSoakCycle(afterFault, {
    cycleIndex: 1,
    attempt: 2,
    runId: "drain-cycle",
    phase: "stable-drain",
    mode: "stable-drain",
    networkProfile: "stable-online",
    seed: DEFAULT_STRESS_SEED + 1,
    exitCode: 0,
    signal: "",
    durationMs: 1_001
  }, 3_002);
  assert.equal(soakPhaseForCheckpoint(complete), "complete");
  assert.equal(complete.faultCyclingDurationMs, 1_001);
  assert.equal(complete.stableDrainDurationMs, 1_001);
  assert.equal(soakCheckpointPassed(complete), true);

  assert.throws(() => recordCompletedSoakCycle(afterFault, {
    cycleIndex: 1,
    attempt: 2,
    runId: "wrong-profile",
    phase: "stable-drain",
    mode: "smoke",
    networkProfile: "fault-cycling",
    seed: DEFAULT_STRESS_SEED + 1,
    exitCode: 0,
    signal: "",
    durationMs: 1_001
  }, 3_002), /stable drain cycle must use/u);

  const soakSource = readFileSync(
    new URL("../../support/run-driver-offline-soak.mjs", import.meta.url),
    "utf8"
  );
  assert.match(soakSource, /DOS_SOAK_SEGMENT_MINUTES/u);
  assert.match(soakSource, /DOS_SOAK_RUN_ID/u);
  assert.match(soakSource, /DOS_SOAK_RUNTIME_IMAGE/u);
  assert.match(soakSource, /DOS_SOAK_E2E_IMAGE/u);
  assert.match(soakSource, /stressSourceState/u);
  assert.match(soakSource, /rename\(temporaryPath, checkpointPath\)/u);
  assert.match(soakSource, /faultCyclingDurationMs/u);
  assert.match(soakSource, /stableDrainDurationMs/u);
});

test("the release soak runs as a source-bound Compose service rather than a leased one-off", () => {
  const composeSource = readFileSync(
    new URL("../../driver-offline-soak.compose.yml", import.meta.url),
    "utf8"
  );
  const artifactsSource = readFileSync(
    new URL("../../support/driver-offline-stress-artifacts.mjs", import.meta.url),
    "utf8"
  );
  const sourceStateScript = readFileSync(
    new URL("../../../tools/driver-offline-stress-source-state.sh", import.meta.url),
    "utf8"
  );
  assert.match(composeSource, /^services:\n  app:/u);
  assert.match(composeSource, /app:\n    image: \$\{DOS_SOAK_RUNTIME_IMAGE:\?[^}]+\}/u);
  assert.match(composeSource, /image: \$\{DOS_SOAK_E2E_IMAGE:\?[^}]+\}/u);
  assert.match(composeSource, /test:driver-offline-stress:soak/u);
  assert.match(composeSource, /DOS_SOAK_RUN_ID: \$\{DOS_SOAK_RUN_ID:\?[^}]+\}/u);
  assert.match(composeSource, /DOS_SOAK_SEGMENT_MINUTES: \$\{DOS_SOAK_SEGMENT_MINUTES:-90\}/u);
  assert.match(composeSource, /DOS_SOAK_RUNTIME_IMAGE: \$\{DOS_SOAK_RUNTIME_IMAGE:\?[^}]+\}/u);
  assert.match(composeSource, /DOS_SOAK_E2E_IMAGE: \$\{DOS_SOAK_E2E_IMAGE:\?[^}]+\}/u);
  assert.match(composeSource, /restart: "no"/u);
  assert.match(artifactsSource, /test\/driver-offline-soak\.compose\.yml/u);
  assert.match(sourceStateScript, /test\/driver-offline-soak\.compose\.yml/u);
});

test("the eight WebKit schema-v1 recovery cases persist ArrayBuffer only", () => {
  const focusedIds = new Set([
    "DOS-001", "DOS-005", "DOS-009", "DOS-013",
    "DOS-017", "DOS-021", "DOS-025", "DOS-029"
  ]);
  const focusedCases = DRIVER_OFFLINE_STRESS_CASES.filter(({ id }) => focusedIds.has(id));
  assert.equal(focusedCases.length, 8);
  for (const testCase of focusedCases) {
    assert.equal(testCase.project, "webkit-mobile");
    assert.equal(testCase.config.legacyDbVersion, 1);
    assert.equal(testCase.config.storageKind, "ArrayBuffer-only");
    assert.match(testCase.title, /ArrayBuffer-only schema-v1 WebKit migration/u);
  }

  const browserSource = readFileSync(
    new URL("../../driver-offline-stress/browser.spec.js", import.meta.url),
    "utf8"
  );
  const seedSource = browserSource.slice(
    browserSource.indexOf("async function seedLegacyDatabase("),
    browserSource.indexOf("async function loadProductionRuntime(")
  );
  assert.match(
    seedSource,
    /const binaryOnly = \["ArrayBuffer-only", "ArrayBuffer"\]\.includes\(storageKind\);/u
  );
  assert.match(seedSource, /binaryOnly \? \{ blobBytes: storedBinary \} : \{ blob: legacyBlob \}/u);
  assert.doesNotMatch(seedSource, /getRandomValues/u);
  assert.match(seedSource, /caseNumber \* 31 \+ byteIndex \* 17/u);
});

test("stress source identity covers the deployable Driver PWA generation", () => {
  const artifactsSource = readFileSync(
    new URL("../../support/driver-offline-stress-artifacts.mjs", import.meta.url),
    "utf8"
  );
  const sourceStateScript = readFileSync(
    new URL("../../../tools/driver-offline-stress-source-state.sh", import.meta.url),
    "utf8"
  );
  for (const file of [
    "public/driver.html",
    "public/driver-reset.html",
    "public/driver-service-worker.js",
    "public/driver.css",
    "public/i18n.css",
    "public/i18n.js",
    "public/driver-photo-hash.js",
    "public/driver-bin-ui.js",
    "src/driver-client-version.js",
    "src/driver-client-version-harness.js",
    "src/driver-offline-client-harness.js",
    "src/driver-photo-integrity-harness.js",
    "src/server.js",
    "test/mbt/e2e/driver-pwa-cache-repair.spec.js",
    "test/mbt/integration/driver-pwa-site-reset-http.test.js",
    "test/mbt/unit/driver-pwa-cache-repair.test.js",
    "test/mbt/unit/driver-pwa-site-reset.test.js",
    "test/mbt/unit/driver-pwa-recovery-assets.test.js",
    "test/mbt/unit/driver-camera-ordinary-upload.test.js",
    "test/driver-offline-soak.compose.yml",
    "test/support/driver-offline-soak-state.mjs"
  ]) {
    assert.match(artifactsSource, new RegExp(file.replaceAll(".", "\\."), "u"));
    assert.match(sourceStateScript, new RegExp(file.replaceAll(".", "\\."), "u"));
  }
});

test("Driver offline randomization is deterministic and seed-sensitive", () => {
  const first = shuffledStressCases(DRIVER_OFFLINE_STRESS_CASES, DEFAULT_STRESS_SEED).map(({ id }) => id);
  const second = shuffledStressCases(DRIVER_OFFLINE_STRESS_CASES, DEFAULT_STRESS_SEED).map(({ id }) => id);
  const other = shuffledStressCases(DRIVER_OFFLINE_STRESS_CASES, DEFAULT_STRESS_SEED + 1).map(({ id }) => id);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);
});

test("anonymized history clone preserves the 425-manifest job distribution and published percentiles", () => {
  const clone = buildHistoricalClone();
  const sorted = clone.map(({ jobCount }) => jobCount).sort((left, right) => left - right);
  const percentile = (ratio) => sorted[Math.ceil(ratio * sorted.length) - 1];
  assert.equal(clone.length, 425);
  assert.equal(percentile(0.5), ANONYMIZED_HISTORY.observedPercentiles.medianJobs);
  assert.equal(percentile(0.95), ANONYMIZED_HISTORY.observedPercentiles.p95Jobs);
  assert.equal(percentile(0.99), ANONYMIZED_HISTORY.observedPercentiles.p99Jobs);
  assert.equal(sorted.at(-1), ANONYMIZED_HISTORY.observedPercentiles.maxJobs);
  assert.equal(P99_ROUTE_PHOTOS, 168);
});

test("adaptive policy never lowers a new capture below the approved 1600px/750KB/0.60 floor", () => {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 250 * 1024 * 1024 }),
    fc.integer({ min: 0, max: 168 }),
    (retainedEvidenceBytes, remainingPhotoCount) => {
      const policy = adaptiveCapturePolicy({ retainedEvidenceBytes, remainingPhotoCount });
      assert.ok(policy.maxEdge >= PRESSURE_CAPTURE_POLICY.maxEdge);
      assert.ok(policy.targetBytes >= PRESSURE_CAPTURE_POLICY.targetBytes);
      assert.ok(policy.minimumQuality >= PRESSURE_CAPTURE_POLICY.minimumQuality);
      assert.equal(policy.appliesTo, "new-captures-only");
    }
  ), { seed: DEFAULT_STRESS_SEED, numRuns: 500 });
});

test("durability property retains local bytes through every non-durable upload prefix", () => {
  fc.assert(fc.property(
    fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }),
    (durableSequence) => {
      const ledger = createLedger();
      persistPhoto(ledger, {
        photoId: "photo-property",
        blobBytes: new Uint8Array([4, 2]).buffer,
        sha256: "a".repeat(64),
        committed: true
      });
      uploadPhoto(ledger, "photo-property");
      for (const durable of durableSequence) {
        if (durable) {
          markDurable(ledger, "photo-property");
          break;
        }
        assert.ok(ledger.photos.get("photo-property").blobBytes);
      }
      assert.deepEqual(verifyLedger(ledger, { expectedClicks: 0 }), []);
    }
  ), { seed: DEFAULT_STRESS_SEED + 7, numRuns: 500 });
});

test("diagnostics redact credentials and bound untrusted values", () => {
  const diagnostic = sanitizeDiagnostic({
    authorization: "Bearer should-not-leak",
    offlineGrant: "grant-should-not-leak",
    message: "x".repeat(5000),
    nested: { password: "synthetic-redaction-input", code: "driver_indexeddb_unknownerror" }
  });
  assert.equal(diagnostic.authorization, "[REDACTED]");
  assert.equal(diagnostic.offlineGrant, "[REDACTED]");
  assert.equal(diagnostic.nested.password, "[REDACTED]");
  assert.equal(diagnostic.message.length, 2000);
  assert.equal(diagnostic.nested.code, "driver_indexeddb_unknownerror");
});

test("evidence preserves all 320 named results while sanitizing each result", () => {
  const results = sanitizeStressResults(DRIVER_OFFLINE_STRESS_CASES.map(({ id }) => ({
    id,
    token: "synthetic-do-not-persist"
  })));
  assert.equal(results.length, 320);
  assert.equal(results[0].id, "DOS-001");
  assert.equal(results.at(-1).id, "DOS-320");
  assert.ok(results.every(({ token }) => token === "[REDACTED]"));
});

test("all eight persisted safety mutants are killed by invariant probes", () => {
  assert.equal(MUTANT_NAMES.length, 8);
  for (const name of MUTANT_NAMES) {
    const defects = mutationProbe(name);
    assert.ok(defects.length > 0, `${name} survived its focused probe.`);
  }
});

test("normal ledger behavior enforces all eight mutation boundaries", () => {
  const ledger = createLedger();
  const event = { eventId: "normal-event", details: { immutable: true } };
  assert.equal(registerLogicalClick(ledger, "job:complete", event), true);
  assert.equal(registerLogicalClick(ledger, "job:complete", { ...event, eventId: "duplicate" }), false);
  const photo = persistPhoto(ledger, {
    photoId: "normal-photo",
    blob: new Blob([new Uint8Array([1, 2, 3])]),
    objectUrl: "blob:must-not-persist",
    blobBytes: new Uint8Array([1, 2, 3]).buffer,
    sha256: "f".repeat(64),
    committed: true
  });
  assert.equal(photo.blob, undefined);
  assert.equal(photo.objectUrl, undefined);
  uploadPhoto(ledger, photo.photoId);
  assert.ok(photo.blobBytes);
  assert.throws(() => recompressPhoto(ledger, photo.photoId), /immutable/iu);
  assert.equal(replayEvent(ledger, event.eventId, { changed: true }), stableJson(event));
  markDurable(ledger, photo.photoId);
  assert.ok(ledger.checkpoints.includes(`durable:${photo.photoId}`));
  assert.equal(admissionAllowed({
    nextBytes: 230 * 1024 * 1024,
    budgetBytes: 250 * 1024 * 1024,
    remainingPhotoCount: 8
  }), false);
  assert.equal(acquireLease(ledger, "tab-a"), true);
  assert.equal(acquireLease(ledger, "tab-b"), false);
});
