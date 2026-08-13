// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TARGET = path.resolve("test/support/driver-offline-stress-model.mjs");
const PROPERTY_TEST = "test/mbt/property/driver-offline-stress-contract.test.js";
const MUTANTS = Object.freeze([
  {
    name: "blob-persistence",
    from: 'const persisted = mutation === "blob-persistence"',
    to: 'const persisted = mutation !== "blob-persistence"'
  },
  {
    name: "premature-byte-deletion",
    from: 'if (mutation === "premature-byte-deletion") {photo.blobBytes = null;}',
    to: 'if (mutation !== "premature-byte-deletion") {photo.blobBytes = null;}'
  },
  {
    name: "committed-photo-recompression",
    from: 'if (photo.committed && mutation !== "committed-photo-recompression") {',
    to: 'if (photo.committed && mutation === "committed-photo-recompression") {'
  },
  {
    name: "missing-click-mutex",
    from: 'if (mutation !== "missing-click-mutex" && ledger.clickKeys.has(clickKey)) {return false;}',
    to: 'if (mutation === "missing-click-mutex" && ledger.clickKeys.has(clickKey)) {return false;}'
  },
  {
    name: "changed-replay-payload",
    from: 'if (mutation === "changed-replay-payload") {event.payload = structuredClone(proposedPayload);}',
    to: 'if (mutation !== "changed-replay-payload") {event.payload = structuredClone(proposedPayload);}'
  },
  {
    name: "skipped-durable-checkpoint",
    from: 'if (mutation !== "skipped-durable-checkpoint") {ledger.checkpoints.push(`durable:${photoId}`);}',
    to: 'if (mutation === "skipped-durable-checkpoint") {ledger.checkpoints.push(`durable:${photoId}`);}'
  },
  {
    name: "ignored-quota-headroom",
    from: "return nextBytes + remaining + reserve <= budgetBytes;",
    to: "return nextBytes <= budgetBytes;"
  },
  {
    name: "lost-sync-lease",
    from: 'if (mutation === "lost-sync-lease") {return true;}',
    to: 'if (mutation !== "lost-sync-lease") {return true;}'
  }
]);

if (process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Driver offline stress mutations require MBT_MUTATION_EPHEMERAL=1 in a disposable writable test container.");
}

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} name */
function runProperty(name) {
  process.stdout.write(`\n[driver-offline-mutation] ${name}\n`);
  return spawnSync(process.execPath, ["--test", "--test-concurrency=1", PROPERTY_TEST], {
    env: process.env,
    stdio: "inherit"
  }).status ?? 1;
}

const original = await readFile(TARGET, "utf8");
const originalDigest = createHash("sha256").update(original).digest("hex");
/** @type {Array<{name: string, killed: boolean, testExitCode: number}>} */
const results = [];
try {
  for (const mutant of MUTANTS) {
    if (occurrences(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one persisted mutation target.`);
    }
    await writeFile(TARGET, original.replace(mutant.from, mutant.to), "utf8");
    const exitCode = runProperty(mutant.name);
    if (exitCode === 0) {throw new Error(`${mutant.name} survived its focused invariant suite.`);}
    results.push({ name: mutant.name, killed: true, testExitCode: exitCode });
    await writeFile(TARGET, original, "utf8");
  }
} finally {
  await writeFile(TARGET, original, "utf8");
}

const restored = await readFile(TARGET, "utf8");
if (createHash("sha256").update(restored).digest("hex") !== originalDigest) {
  throw new Error("Driver offline stress mutation source restoration failed.");
}
if (runProperty("post-mutation green") !== 0) {
  throw new Error("Driver offline stress invariant suite failed after restoring its source.");
}
const artifactDirectory = path.resolve("test-artifacts/driver-offline-stress/mutation");
await mkdir(artifactDirectory, { recursive: true });
await writeFile(path.join(artifactDirectory, "mutation-report.json"), `${JSON.stringify({
  schemaVersion: 1,
  killed: results.length,
  total: MUTANTS.length,
  score: results.length / MUTANTS.length,
  sourceRestored: true,
  results
}, null, 2)}\n`, "utf8");
console.log(`Driver offline stress mutation score: ${results.length}/${MUTANTS.length} killed (100%); source restored.`);
