// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const FRONTEND_TESTS = Object.freeze([
  "test/dispatch/frontend/scm-po-split-ui.test.js",
  "test/dispatch/frontend/scm-schedule-status-save.test.js"
]);
const DATABASE_TESTS = Object.freeze([
  "test/mbt/integration/scm-schedule-status-concurrency.test.js",
  "test/mbt/integration/scm-schedule-status-http.test.js",
  "test/dispatch/integration/scm-po-split-editing.test.js"
]);
const MUTANTS = Object.freeze([
  {
    name: "PO Schedule ignores canonical Driver completion",
    target: "src/dispatch-repository.js",
    from: "     AND dispatch_completion.dispatch_completion_status = 'completed'",
    to: "     AND dispatch_completion.dispatch_completion_status = 'disabled-by-mutant'"
  },
  {
    name: "PO Schedule completion contaminates sibling split references",
    target: "src/dispatch-repository.js",
    from: "     AND lower(btrim(dispatch_completion.order_ref)) = lower(btrim(b.order_ref))",
    to: "     AND true"
  },
  {
    name: "PO Schedule drops non-Driver completion projection",
    target: "src/dispatch-repository.js",
    from: "        WHEN dispatch_completion.completion_event_id IS NOT NULL\n          THEN 'Completed'",
    to: "        WHEN false\n          THEN 'Completed'"
  },
  {
    name: "PO Schedule lets a reconciliation review override Driver completion",
    target: "src/dispatch-repository.js",
    from: "        WHEN dispatch_completion.completion_evidence_type = 'driver_job'\n          THEN 'Completed'",
    to: "        WHEN false\n          THEN 'Completed'"
  },
  {
    name: "reconciliation enrichment lets review override Driver completion",
    target: "src/scm-reconciliation-repository.js",
    from: "    const driverCompleted = text(row.dispatchCompletionEvidenceType).toLowerCase() === \"driver_job\";",
    to: "    const driverCompleted = false;"
  },
  {
    name: "active split ref no longer fills a blank packing slip",
    target: "src/dispatch-repository.js",
    from: "        NULLIF(b.split_ref, ''),\n        ''",
    to: "        NULL::text,\n        ''"
  },
  {
    name: "stale revisions bypass the atomic upsert predicate",
    target: "src/dispatch-repository.js",
    from: "     WHERE NOT $20::boolean\n        OR (",
    to: "     WHERE $20::boolean IS NOT NULL\n        OR ("
  },
  {
    name: "successful saves keep the old revision token",
    target: "src/dispatch-repository.js",
    from: "       notes = EXCLUDED.notes,\n       updated_by = EXCLUDED.updated_by,\n       updated_at = GREATEST(clock_timestamp(), scm_transport_schedule.updated_at + interval '1 microsecond')",
    to: "       notes = EXCLUDED.notes,\n       updated_by = EXCLUDED.updated_by,\n       updated_at = scm_transport_schedule.updated_at"
  },
  {
    name: "split identity overrides a genuinely entered packing slip",
    target: "src/dispatch-repository.js",
    from: "        NULLIF(s.packing_slip_ref, ''),\n        NULLIF(b.dispatch_ref, ''),\n        NULLIF(b.split_ref, ''),",
    to: "        NULLIF(b.split_ref, ''),\n        NULLIF(b.dispatch_ref, ''),\n        NULLIF(s.packing_slip_ref, ''),"
  },
  {
    name: "HTTP mutations stop requiring a loaded schedule revision",
    target: "src/server.js",
    occurrences: 3,
    from: "expectedUpdatedAt: requiredScmScheduleRevision(req.body || {})",
    to: "expectedUpdatedAt: undefined"
  },
  {
    name: "PO Split submits an absence token instead of its loaded revision",
    target: "public/dispatch-scm.js",
    from: "    expectedUpdatedAt: order?.scm?.updatedAt || null",
    to: "    expectedUpdatedAt: null"
  },
  {
    name: "PO Split discards the failed status draft",
    target: "public/dispatch-scm.js",
    from: "    if (![\"orderKind\", \"expectedUpdatedAt\"].includes(key)) order.scm[key] = value;",
    to: "    if (false && ![\"orderKind\", \"expectedUpdatedAt\"].includes(key)) order.scm[key] = value;"
  },
  {
    name: "PO TO Schedule submits an absence token instead of its loaded revision",
    target: "public/scm-schedule.js",
    from: "    expectedUpdatedAt: row?.updatedAt || null",
    to: "    expectedUpdatedAt: null"
  },
  {
    name: "PO TO Schedule leaves row editors active during save",
    target: "public/scm-schedule.js",
    from: "    setScmScheduleRowControlsDisabled(rowId, true);",
    to: "    setScmScheduleRowControlsDisabled(rowId, false);"
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

function runFrontendTests() {
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...FRONTEND_TESTS
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

/** @param {string} label */
async function runFocusedTests(label) {
  const frontend = runFrontendTests();
  if (frontend !== 0) {
    return frontend;
  }
  return runNodeTestFilesIsolated([...DATABASE_TESTS], {
    environment: process.env,
    label
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("SCM schedule-status mutations require the writable disposable MBT test container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string") {
      throw new Error(`Missing mutation source ${mutant.target}.`);
    }
    const expectedOccurrences = mutant.occurrences || 1;
    if (occurrenceCount(original, mutant.from) !== expectedOccurrences) {
      throw new Error(`${mutant.name}: expected ${expectedOccurrences} mutation target occurrence(s).`);
    }
    await writeFile(
      path.resolve(mutant.target),
      original.replaceAll(mutant.from, mutant.to),
      "utf8"
    );
    const result = await runFocusedTests(`SCM schedule-status mutant: ${mutant.name}`);
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused regression.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    const restored = await readFile(path.resolve(target), "utf8");
    if (sha256(restored) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

if (killed !== MUTANTS.length) {
  throw new Error(`SCM schedule-status mutation score ${killed}/${MUTANTS.length}.`);
}
const finalResult = await runFocusedTests("SCM schedule-status post-mutation green");
if (finalResult !== 0) {
  throw new Error("SCM schedule-status tests failed after restoring mutation sources.");
}
console.log(`SCM schedule-status mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
