// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TARGET = "src/scm-split-status-evidence-precedence.js";
const TESTS = Object.freeze([
  "test/mbt/unit/scm-split-po-status-evidence-precedence.red.test.js",
  "test/mbt/property/scm-split-po-status-evidence-precedence.property.test.js",
  "test/mbt/adversarial/scm-split-po-status-evidence-precedence.adversarial.test.js"
]);
const MUTANTS = Object.freeze([
  {
    name: "unrelated reconciliation targets are treated as split children",
    from: 'if (!SPLIT_TARGET_KINDS.has(String(targetKind || "").trim().toLowerCase())) {',
    to: "if (false) {"
  },
  {
    name: "closed and cancelled lifecycle decisions are overridden",
    from: "if (lifecycle.closed || lifecycle.cancelled) return derivedState;",
    to: "if (false) return derivedState;"
  },
  {
    name: "previous Completed is no longer monotonic",
    from: 'const previousCompleted = ["complete", "completed"].includes(',
    to: 'const previousCompleted = ["never-completed"].includes('
  },
  {
    name: "every review is hidden as an inferred completion loss",
    from: "&& String(derivedState.reason || \"\").trim() === LOST_COMPLETION_EVIDENCE_REASON;",
    to: "&& true;"
  },
  {
    name: "Partially Done is allowed to regress from Completed",
    from: '["Queued", "Partially Done", "In Transit"].includes(applicationStatus)',
    to: '["Queued", "In Transit"].includes(applicationStatus)'
  },
  {
    name: "zero exact evidence is treated as progress",
    from: "quantity(evidencedFulfilledQty) > EPSILON",
    to: "quantity(evidencedFulfilledQty) >= 0"
  },
  {
    name: "an active plan no longer restores Planned",
    from: 'return hasActivePlan ? "Planned" : "Queued";',
    to: 'return "Queued";'
  },
  {
    name: "manual non-progress status is discarded",
    from: "if (SPLIT_NON_PROGRESS_STATUSES.has(previous)) return previous;",
    to: "if (false) return previous;"
  }
]);

/** @param {string} source */
function hash(source) {
  return createHash("sha256").update(source).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[SCM split status mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...TESTS
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
  throw new Error("SCM split status mutations require the writable disposable mutation container.");
}

const targetPath = path.resolve(TARGET);
const original = await readFile(targetPath, "utf8");
const originalHash = hash(original);
let killed = 0;
try {
  if (runTests("baseline") !== 0) {
    throw new Error("Focused baseline failed before mutation.");
  }
  for (const mutant of MUTANTS) {
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(targetPath, original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(targetPath, original, "utf8");
  }
} finally {
  await writeFile(targetPath, original, "utf8");
  if (hash(await readFile(targetPath, "utf8")) !== originalHash) {
    throw new Error(`Mutation source restoration failed for ${TARGET}.`);
  }
}

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(`SCM split status mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
