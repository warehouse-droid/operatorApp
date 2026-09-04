// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UI_TEST = "test/dispatch/frontend/scm-po-line-sequence.red.test.js";
const INTEGRATION_TEST = "test/dispatch/integration/scm-po-stale-line-pallet-conservation.red.test.js";
const CONTRACT_TEST = "test/dispatch/unit/scm-po-netsuite-line-sequence.contract.test.js";

/** @type {ReadonlyArray<{
 * name: string,
 * target: string,
 * from: string,
 * to: string,
 * tests: readonly string[]
 * }>} */
const MUTANTS = Object.freeze([
  {
    name: "the browser reverses NetSuite sequence",
    target: "public/dispatch-scm.js",
    from: "    if (leftSequence !== rightSequence) return leftSequence - rightSequence;",
    to: "    if (leftSequence !== rightSequence) return rightSequence - leftSequence;",
    tests: [UI_TEST]
  },
  {
    name: "the browser hides NetSuite line labels",
    target: "public/dispatch-scm.js",
    from: '  return sequence === null ? "" : `NetSuite line ${sequence.toLocaleString("en-CA")}`;',
    to: '  return "";',
    tests: [UI_TEST]
  },
  {
    name: "the source API reverses NetSuite sequence",
    target: "src/dispatch-repository.js",
    from: "    if (leftSequence !== rightSequence) return leftSequence - rightSequence;",
    to: "    if (leftSequence !== rightSequence) return rightSequence - leftSequence;",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "candidate capacity restores historical requested quantity",
    target: "src/scm-reconciliation-repository.js",
    from: "      >= linkedSalesQty + existingSplitQty + currentQty",
    to: "      >= linkedSalesQty + existingSplitQty + requestedQty",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "the split ledger is reset to historical requested quantity",
    target: "src/scm-reconciliation-repository.js",
    from: "              unit = NULLIF($6, '')\n        WHERE id = $1`,",
    to: "              unit = NULLIF($6, ''),\n              sales_qty = requested_sales_qty\n        WHERE id = $1`,",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "the child is reset to historical requested quantity",
    target: "src/scm-reconciliation-repository.js",
    from: "        reconciliationQuantity(candidate.to_pcs),\n        reconciliationQuantity(ledger.sales_qty),",
    to: "        reconciliationQuantity(candidate.to_pcs),\n        reconciliationQuantity(ledger.requested_sales_qty),",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "the remapped child loses replacement sequence metadata",
    target: "src/scm-reconciliation-repository.js",
    from: "              ? { lineSequenceNumber }\n              : {}),",
    to: "              ? { ignoredLineSequenceNumber: lineSequenceNumber }\n              : {}),",
    tests: [INTEGRATION_TEST]
  },
  {
    name: "ordinary NetSuite PO detail returns unique-key order",
    target: "src/netsuite.js",
    from: "    ORDER BY tl.linesequencenumber, tl.id, tl.uniquekey",
    to: "    ORDER BY tl.uniquekey",
    tests: [CONTRACT_TEST]
  }
]);

/** @param {string} value */
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label @param {readonly string[]} tests */
function runTests(label, tests) {
  process.stdout.write(`\n[PO line sequence/conservation mutation] ${label}\n`);
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
  throw new Error("PO line sequence/conservation mutations require the writable disposable mutation container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const originalHashes = new Map();
for (const target of targets) {
  const original = await readFile(path.resolve(target), "utf8");
  originals.set(target, original);
  originalHashes.set(target, hash(original));
}

const baselineTests = [UI_TEST, INTEGRATION_TEST, CONTRACT_TEST];
if (runTests("baseline", baselineTests) !== 0) {
  throw new Error("Focused mutation tests do not start green.");
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (original === undefined || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(
      path.resolve(mutant.target),
      original.replace(mutant.from, mutant.to),
      "utf8"
    );
    if (runTests(mutant.name, mutant.tests) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const target of targets) {
    const original = originals.get(target);
    if (original === undefined) {
      continue;
    }
    await writeFile(path.resolve(target), original, "utf8");
    if (hash(await readFile(path.resolve(target), "utf8")) !== originalHashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

if (runTests("post-mutation restored source", baselineTests) !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}

console.log(`PO line sequence/conservation mutation score: ${killed}/${MUTANTS.length} killed (100%).`);
