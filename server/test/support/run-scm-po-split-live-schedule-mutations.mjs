// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TARGET = "src/dispatch-repository.js";
const TEST = "test/mbt/integration/scm-schedule-status-concurrency.test.js";
const MUTANTS = Object.freeze([
  {
    name: "PO reference synchronization regresses to transaction start time",
    from: "              updated_at = GREATEST(clock_timestamp(), s.updated_at + interval '1 microsecond')",
    to: "              updated_at = now()"
  },
  {
    name: "schedule save returns the pre-rename row instead of the committed identity",
    from: "    return committed.rows[0] || result.rows[0];",
    to: "    return result.rows[0];"
  }
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function run(label) {
  process.stdout.write(`\n[PO Split live schedule mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    TEST
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("PO Split live-schedule mutations require the writable disposable mutation container.");
}

const targetPath = path.resolve(TARGET);
const original = await readFile(targetPath, "utf8");
const originalHash = sha256(original);
if (run("baseline") !== 0) {
  throw new Error("Focused mutation tests do not start green.");
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(targetPath, original.replace(mutant.from, mutant.to), "utf8");
    if (run(mutant.name) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(targetPath, original, "utf8");
  }
} finally {
  await writeFile(targetPath, original, "utf8");
  if (sha256(await readFile(targetPath, "utf8")) !== originalHash) {
    throw new Error(`Mutation source restoration failed for ${TARGET}.`);
  }
}

if (run("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after restoring the mutation source.");
}
console.log(`PO Split live schedule mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
