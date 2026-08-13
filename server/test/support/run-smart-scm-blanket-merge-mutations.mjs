// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const TARGET = path.resolve("src/smart-scm-blanket-repository.js");
const TESTS = Object.freeze([
  "test/mbt/property/smart-scm-blanket-merge-selection.property.test.js",
  "test/mbt/integration/smart-scm-blanket-load-merge.test.js"
]);
const MUTANTS = Object.freeze([
  {
    name: "one unique load satisfies the merge minimum",
    from: "if (ids.length < 2) throw httpError(\"Select at least two Blanket loads to merge.\");",
    to: "if (ids.length < 1) throw httpError(\"Select at least two Blanket loads to merge.\");"
  },
  {
    name: "twenty-one loads bypass the bounded selection",
    from: "if (ids.length > 20) throw httpError(\"Merge no more than 20 Blanket loads at once.\");",
    to: "if (ids.length > 21) throw httpError(\"Merge no more than 20 Blanket loads at once.\");"
  },
  {
    name: "mixed source Blanket POs are accepted",
    from: "if (!integer(first.blanket_source_po_id)\n      || selected.some((proposal) => Number(proposal.blanket_source_po_id) !== Number(first.blanket_source_po_id)\n        || text(proposal.blanket_source_po_ref).toLowerCase() !== text(first.blanket_source_po_ref).toLowerCase())) {",
    to: "if (!integer(first.blanket_source_po_id)) {"
  },
  {
    name: "reserved Blanket loads can be merged",
    from: "if (releases.rowCount) {\n      throw httpError(\"A selected Blanket load is already reserved or has vendor history and cannot be merged.\", 409);\n    }",
    to: "if (false && releases.rowCount) {\n      throw httpError(\"A selected Blanket load is already reserved or has vendor history and cannot be merged.\", 409);\n    }"
  },
  {
    name: "one extra destination bypasses the route limit",
    from: "if (new Set(combined.map((line) => line.destinationLocationId)).size > maximumDrops) {",
    to: "if (new Set(combined.map((line) => line.destinationLocationId)).size > maximumDrops + 1) {"
  },
  {
    name: "merge allocation ignores the configured truck capacity",
    from: "[allocated] = smartScmAllocateProRata(weighted, settings.truck_capacity_lbs);",
    to: "[allocated] = smartScmAllocateProRata(weighted, positive(settings.truck_capacity_lbs) * 10);"
  },
  {
    name: "idempotent retries skip replacement recovery",
    from: "if (replay) return replay;",
    to: "if (false && replay) return replay;"
  },
  {
    name: "superseded source loads remain visible in the active workspace",
    from: "const activeProposals = run.proposals.filter((proposal) => proposal.status !== \"superseded\");",
    to: "const activeProposals = run.proposals;"
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
  throw new Error("Blanket merge mutations require the writable disposable MBT test container.");
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
      label: `Blanket merge mutant: ${mutant.name}`
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
    throw new Error("Blanket merge mutation source restoration failed.");
  }
}

const finalResult = await runNodeTestFilesIsolated([...TESTS], {
  environment: process.env,
  label: "Blanket merge post-mutation green"
});
if (finalResult !== 0) {
  throw new Error("Blanket merge tests failed after restoring mutation sources.");
}
console.log(`Blanket merge mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
