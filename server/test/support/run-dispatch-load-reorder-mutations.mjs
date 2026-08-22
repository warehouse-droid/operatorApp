// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TARGET = path.resolve("public/dispatch.js");
const DETECTOR = "test/dispatch/frontend/dispatch-load-reorder-position.red.test.js";

const MUTANTS = Object.freeze([
  {
    name: "same-lane reorder does not capture positional metadata",
    from: `  const positionMetadata = sourceLogin === targetLogin
    ? driverLanePositionMetadata(sourceLaneEntries, timingByLoad)
    : null;`,
    to: "  const positionMetadata = null;"
  },
  {
    name: "start mode remains attached to load identity",
    from: `    const startMode = positionalStart?.startMode === "fixed" || positionalStart?.startMode === "auto"
      ? positionalStart.startMode
      : resolvedLoadStartMode(entry.load);`,
    to: "    const startMode = resolvedLoadStartMode(entry.load);"
  },
  {
    name: "fixed start remains attached to load identity",
    from: "    const fixedStart = normalizeTypedDispatchTime(positionalStart ? positionalStart.start : entry.load.start);",
    to: "    const fixedStart = normalizeTypedDispatchTime(entry.load.start);"
  },
  {
    name: "starting yard is transferred to Load 2 instead of Load 1",
    from: "    if (index === 0 && positionMetadata?.length) {",
    to: "    if (index === 1 && positionMetadata?.length) {"
  },
  {
    name: "moved fixed load is recalculated by identity despite positional timing",
    from: "      if (startMode === \"auto\" || (!positionMetadata && entry.load.id === movedLoadId) || start < earliest) start = earliest;",
    to: "      if (startMode === \"auto\" || entry.load.id === movedLoadId || start < earliest) start = earliest;"
  },
  {
    name: "Start Yard ownership falls back to physical array order",
    from: `    const sameDriverLane = loadDriverKey(left.truck, left.load) === loadDriverKey(right.truck, right.load);
    const laneSequenceDifference = sameDriverLane ? left.sequence - right.sequence : 0;
    return laneSequenceDifference
      || minutes(left.load.start || left.truck.start || DEFAULT_FIRST_LOAD_START)
        - minutes(right.load.start || right.truck.start || DEFAULT_FIRST_LOAD_START)
      || left.sequence - right.sequence`,
    to: `    return minutes(left.load.start || left.truck.start || DEFAULT_FIRST_LOAD_START)
        - minutes(right.load.start || right.truck.start || DEFAULT_FIRST_LOAD_START)
      || left.truckIndex - right.truckIndex`
  }
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @returns {Promise<number>} */
function runDetector() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      DETECTOR
    ], { env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Dispatch load-reorder detector exited on signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch load-reorder mutations require the writable disposable MBT test image.");
}

const original = await readFile(TARGET, "utf8");
const originalHash = sha256(original);
if (await runDetector() !== 0) {
  throw new Error("Dispatch load-reorder mutation baseline must be green.");
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    await writeFile(TARGET, original.replace(mutant.from, mutant.to), "utf8");
    if (await runDetector() === 0) {
      throw new Error(`${mutant.name}: survived the focused detector.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(TARGET, original, "utf8");
  }
} finally {
  await writeFile(TARGET, original, "utf8");
  if (sha256(await readFile(TARGET, "utf8")) !== originalHash) {
    throw new Error("Dispatch load-reorder mutation source restoration hash mismatch.");
  }
}

if (await runDetector() !== 0) {
  throw new Error("Dispatch load-reorder detector failed after source restoration.");
}

console.log(`Dispatch load-reorder mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
