// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const TARGET = path.resolve("src/dispatch-repository.js");
const TEST = "test/mbt/integration/scm-po-split-ref-reuse.test.js";
const MUTANTS = Object.freeze([
  {
    name: "cancelled split children still reserve their old ref",
    from: "AND retired_split.status = 'cancelled'\n            )\n         UNION\n         SELECT split_po_ref AS tranid\n           FROM dispatch_scm_po_splits",
    to: "AND retired_split.status = 'active'\n            )\n         UNION\n         SELECT split_po_ref AS tranid\n           FROM dispatch_scm_po_splits"
  },
  {
    name: "a renamed PO keeps reserving its original tranid",
    from: "WHERE lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid)) = lower($1)\n            AND NOT EXISTS (\n              SELECT 1\n                FROM dispatch_scm_po_splits retired_split",
    to: "WHERE lower(po.tranid) = lower($1)\n            AND NOT EXISTS (\n              SELECT 1\n                FROM dispatch_scm_po_splits retired_split"
  },
  {
    name: "reused refs regenerate the retired child PO identity",
    from: "syntheticPurchaseOrderId(`scm-po:${source.netsuite_id}:${splitRef}:${splitHeaderId}`)",
    to: "syntheticPurchaseOrderId(`scm-po:${source.netsuite_id}:${splitRef}`)"
  },
  {
    name: "reused refs regenerate retired child line identities",
    from: "syntheticPurchaseOrderId(`scm-po-line:${split.id}:${splitRef}:${childLineIdentity}`)",
    to: "syntheticPurchaseOrderId(`scm-po-line:${splitRef}:${childLineIdentity}`)"
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
  throw new Error("SCM PO split mutations require the writable disposable MBT test container.");
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
    const result = await runNodeTestFilesIsolated([TEST], {
      environment: process.env,
      label: `SCM PO split mutant: ${mutant.name}`
    });
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused regression.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(TARGET, original, "utf8");
  }
} finally {
  await writeFile(TARGET, original, "utf8");
  if (sha256(await readFile(TARGET, "utf8")) !== originalHash) {
    throw new Error("SCM PO split mutation source restoration failed.");
  }
}

if (killed !== MUTANTS.length) {
  throw new Error(`SCM PO split mutation score ${killed}/${MUTANTS.length}.`);
}
const finalResult = await runNodeTestFilesIsolated([TEST], {
  environment: process.env,
  label: "SCM PO split post-mutation green"
});
if (finalResult !== 0) {
  throw new Error("SCM PO split tests failed after restoring mutation sources.");
}
console.log(`SCM PO split mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
