// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const TARGET = path.resolve("src/dispatch-history-mode.js");
const TESTS = Object.freeze([
  "test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js"
]);
const MUTANTS = Object.freeze([
  {
    name: "split relationships become bidirectional and contaminate siblings",
    from: "       UNION\n       SELECT parent_ref, child_ref\n         FROM split_relations\n     ),",
    to: "       UNION\n       SELECT parent_ref, child_ref\n         FROM split_relations\n       UNION\n       SELECT child_ref, parent_ref\n         FROM split_relations\n     ),"
  },
  {
    name: "cancelled PO split relationships remain active",
    from: "           SELECT source_po_ref AS parent_ref,\n                  split_po_ref AS child_ref\n             FROM dispatch_scm_po_splits\n            WHERE LOWER(BTRIM(COALESCE(status, ''))) = 'active'",
    to: "           SELECT source_po_ref AS parent_ref,\n                  split_po_ref AS child_ref\n             FROM dispatch_scm_po_splits\n            WHERE true"
  },
  {
    name: "inactive schedule groups remain active",
    from: "           SELECT group_row.group_ref AS parent_ref,\n                  member.order_ref AS child_ref\n             FROM scm_schedule_groups group_row\n             JOIN scm_schedule_group_members member ON member.group_id = group_row.id\n            WHERE LOWER(BTRIM(COALESCE(group_row.status, ''))) = 'active'",
    to: "           SELECT group_row.group_ref AS parent_ref,\n                  member.order_ref AS child_ref\n             FROM scm_schedule_groups group_row\n             JOIN scm_schedule_group_members member ON member.group_id = group_row.id\n            WHERE true"
  },
  {
    name: "source completion no longer propagates to split descendants",
    from: "       SELECT parent_ref, child_ref\n         FROM split_relations\n     ),",
    to: "       SELECT child_ref, parent_ref\n         FROM split_relations\n     ),"
  },
  {
    name: "group relationships lose reverse traversal",
    from: "       UNION\n       SELECT child_ref, parent_ref\n         FROM group_relations\n       UNION",
    to: "       UNION"
  },
  {
    name: "Driver complete status is ignored",
    from: "        WHERE LOWER(BTRIM(COALESCE(record.status, ''))) IN ('complete', 'completed')",
    to: "        WHERE LOWER(BTRIM(COALESCE(record.status, ''))) IN ('completed')"
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

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch completion mutations require the writable disposable MBT test container.");
}

const original = await readFile(TARGET, "utf8");
const originalHash = sha256(original);
let killed = 0;
try {
  for (const mutant of MUTANTS) {
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    await writeFile(TARGET, original.replace(mutant.from, mutant.to), "utf8");
    const result = await runNodeTestFilesIsolated([...TESTS], {
      environment: process.env,
      label: `Dispatch completion mutant: ${mutant.name}`
    });
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused regressions.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(TARGET, original, "utf8");
  }
} finally {
  await writeFile(TARGET, original, "utf8");
  if (sha256(await readFile(TARGET, "utf8")) !== originalHash) {
    throw new Error("Dispatch completion mutation source restoration failed.");
  }
}

const finalResult = await runNodeTestFilesIsolated([...TESTS], {
  environment: process.env,
  label: "Dispatch completion post-mutation green"
});
if (finalResult !== 0) {
  throw new Error("Dispatch completion tests failed after restoring mutation sources.");
}
console.log(`Dispatch completion mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
