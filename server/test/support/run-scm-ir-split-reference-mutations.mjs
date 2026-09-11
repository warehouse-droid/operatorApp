// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FULL_TESTS = Object.freeze([
  "test/mbt/unit/scm-ir-split-reference.red.test.js",
  "test/mbt/unit/scm-split-receipt-allocation.red.test.js",
  "test/mbt/property/scm-ir-split-reference.property.test.js",
  "test/mbt/integration/scm-split-receipt-allocation.red.test.js"
]);
const PROPERTY_TESTS = Object.freeze([
  "test/mbt/property/scm-ir-split-reference.property.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "spaced NetSuite child references stop parsing",
    property: true,
    target: "src/scm-ir-split-reference.js",
    from: "const SPLIT_REFERENCE_PATTERN = /\\bSN\\s*[-#:]?\\s*\\d+\\b/giu;",
    to: "const SPLIT_REFERENCE_PATTERN = /\\bSN[-#:]?\\d+\\b/giu;"
  },
  {
    name: "foreign references fall back to the destination allocator",
    property: true,
    target: "src/scm-ir-split-reference.js",
    from: "  if (references.length === 1) return { status: \"unmatched\", reference: references[0] };",
    to: "  if (references.length === 1) return { status: \"absent\" };"
  },
  {
    name: "valid referenced quantity is discarded",
    property: true,
    target: "src/scm-ir-split-reference.js",
    from: "    const applied = quantity(Math.min(budget, capacity));",
    to: "    const applied = 0;"
  },
  {
    name: "a matched IR is routed to the next child",
    property: true,
    target: "src/scm-ir-split-reference.js",
    from: "    const target = normalizedTargets[resolution.targetIndex] || {};",
    to: "    const target = normalizedTargets[resolution.targetIndex + 1] || {};"
  },
  {
    name: "multiple foreign child references are treated as absent",
    target: "src/scm-ir-split-reference.js",
    from: "  if (references.length > 1 || matches.length > 1) {",
    to: "  if (matches.length > 1) {"
  },
  {
    name: "IR rows without a child reference disappear",
    target: "src/scm-ir-split-reference.js",
    from: "      remainingReceiptRows.push(row);",
    to: "      remainingReceiptRows.push();"
  },
  {
    name: "referenced quantity may exceed child line capacity",
    target: "src/scm-ir-split-reference.js",
    from: "    const applied = quantity(Math.min(budget, capacity));",
    to: "    const applied = budget;"
  },
  {
    name: "destination reconciliation bypasses IR memo evidence",
    target: "src/scm-split-receipt-allocation.js",
    from: "    receiptRows: allReceiptRows\n  });",
    to: "    receiptRows: []\n  });"
  },
  {
    name: "SuiteQL returns a blank IR memo",
    target: "src/netsuite.js",
    from: "        event_t.memo AS transaction_memo,",
    to: "        NULL AS transaction_memo,"
  },
  {
    name: "snapshot storage drops the imported IR memo",
    target: "src/scm-reconciliation-repository.js",
    from: "      normalized.transactionMemo,\n      normalized.sourceOrderKind,",
    to: "      \"\",\n      normalized.sourceOrderKind,"
  },
  {
    name: "BWS blanket HOLD children cannot use location evidence",
    target: "src/scm-reconciliation-repository.js",
    from: "      allowInferredReceipt: order.isBlanketPo === true\n        || Boolean(row.completion_event_id)",
    to: "      allowInferredReceipt: false\n        || Boolean(row.completion_event_id)"
  },
  {
    name: "ambiguous BWS destination matches choose the first child",
    target: "src/scm-split-receipt-allocation.js",
    from: "      ) && unfinishedAtLocation.length !== 1",
    to: "      ) && false"
  }
]);

const propertyOnly = process.env.MBT_MUTATION_PROPERTY_ONLY === "1";
const selectedMutants = propertyOnly ? MUTANTS.filter((mutant) => mutant.property) : MUTANTS;
const tests = propertyOnly ? PROPERTY_TESTS : FULL_TESTS;

/** @param {string} value */
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} source
 * @param {string} needle
 */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[SCM IR reference mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...tests
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
  throw new Error("SCM IR reference mutations require the writable disposable mutation container.");
}

const targets = [...new Set(selectedMutants.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, hash(source));
}

let killed = 0;
try {
  for (const mutant of selectedMutants) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${selectedMutants.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (hash(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(
  `SCM IR reference ${propertyOnly ? "property " : ""}mutation score: `
  + `${killed}/${selectedMutants.length} killed (100%); sources restored.`
);
