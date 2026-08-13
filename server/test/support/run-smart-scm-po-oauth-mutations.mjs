// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const REFERENCE_UNIT = "test/mbt/unit/scm-po-vendor-reference.test.js";
const FINANCIAL_UNIT = "test/mbt/unit/smart-scm-vendor-financials.test.js";
const PURCHASE_REVIEW = "src/smart-scm-purchase-review-harness.js";
const VENDOR_UI = "src/smart-scm-vendor-ui-harness.js";
const HISTORY_UI = "src/scm-netsuite-po-preview-ui-harness.js";
const HISTORY_CONTRACT = "src/scm-netsuite-po-history-harness.js";
const BLANKET_UI = "src/smart-scm-blanket-ui-harness.js";
const HISTORY_DB = "src/scm-netsuite-po-history-filter-harness.js";

const MUTANTS = Object.freeze([
  {
    name: "Vendor Replies ignores the vendor-specific price",
    target: "src/smart-scm-vendor-financials.js",
    tests: [FINANCIAL_UNIT],
    from: "const lastPurchasePrice = snapshottedPrice ?? vendorPrice ?? currentLastPurchasePrice;",
    to: "const lastPurchasePrice = snapshottedPrice ?? currentLastPurchasePrice;"
  },
  {
    name: "zero vendor price blocks the Last Purchase Price fallback",
    target: "src/smart-scm-vendor-financials.js",
    tests: [FINANCIAL_UNIT],
    from: "return parsed !== null && parsed > 0 ? parsed : null;",
    to: "return parsed !== null && parsed >= 0 ? parsed : null;"
  },
  {
    name: "Vendor Reply financial quantity stops using sales quantity",
    target: "src/smart-scm-vendor-financials.js",
    tests: [FINANCIAL_UNIT],
    from: "for (const value of [line.purchaseQuantity, line.salesQuantity, line.quantity]) {",
    to: "for (const value of [line.purchaseQuantity, line.proposedPallets, line.quantity]) {"
  },
  {
    name: "unit mismatch is allowed to create a monetary amount",
    target: "src/smart-scm-vendor-financials.js",
    tests: [FINANCIAL_UNIT],
    from: "lastPurchasePrice === null || purchaseUnitMismatch",
    to: "lastPurchasePrice === null && purchaseUnitMismatch"
  },
  {
    name: "explicit empty Vendor reference can no longer clear the value",
    target: "src/scm-po-vendor-reference.js",
    tests: [REFERENCE_UNIT],
    from: "if (incoming || explicitApplicationEdit) return incoming;",
    to: "if (incoming) return incoming;"
  },
  {
    name: "explicitly cleared Vendor reference falls back to the legacy dispatch reference",
    target: "src/scm-netsuite-po-history-repository.js",
    tests: [HISTORY_DB],
    database: true,
    from: "row.vendor_reference === null || row.vendor_reference === undefined",
    to: "!text(row.vendor_reference)"
  },
  {
    name: "empty LYR is sent to NetSuite as zero",
    target: "src/smart-scm-purchase-netsuite.js",
    tests: [PURCHASE_REVIEW],
    from: "if (layerQty !== undefined) payloadLine.custcol_lyr = layerQty;",
    to: "payloadLine.custcol_lyr = layerQty ?? 0;"
  },
  {
    name: "Vendor Replies PDF drops the application bearer token",
    target: "public/scm-smart-vendor.js",
    tests: [VENDOR_UI],
    from: "headers: dispatchAuthHeaders({ Accept: \"application/pdf\" })",
    to: "headers: { Accept: \"application/pdf\" }"
  },
  {
    name: "PO History PDF drops the application bearer token",
    target: "public/scm-netsuite-po.js",
    tests: [HISTORY_UI],
    from: "headers: dispatchAuthHeaders({ Accept: \"application/pdf\" })",
    to: "headers: { Accept: \"application/pdf\" }"
  },
  {
    name: "missing PO Amount is rendered as zero dollars",
    target: "public/scm-netsuite-po.js",
    tests: [HISTORY_CONTRACT],
    from: "if (value === null || value === undefined || value === \"\") return \"—\";",
    to: "if (false && (value === null || value === undefined || value === \"\")) return \"—\";"
  },
  {
    name: "Blanket filters hide every proposal when search is empty",
    target: "public/scm-smart-blanket.js",
    tests: [BLANKET_UI],
    from: "if (!search) return true;",
    to: "if (!search) return false;"
  },
  {
    name: "canonical PO line upsert discards NetSuite Rate",
    target: "src/order-sync-repository.js",
    tests: [HISTORY_DB],
    database: true,
    from: "rate: normalizeNumber(line.rate),",
    to: "rate: null,"
  },
  {
    name: "same-timestamp reconciliation skips financial line repair",
    target: "src/scm-netsuite-po-history-repository.js",
    tests: [HISTORY_DB],
    database: true,
    from: "for (const line of snapshot.lines || []) {",
    to: "for (const line of []) {"
  },
  {
    name: "financial backfill refuses an empty dedicated Rate column",
    target: "migrations/148_scm_po_history_line_financial_backfill.sql",
    tests: [HISTORY_DB],
    database: true,
    from: "WHEN rate IS NOT NULL THEN rate",
    to: "WHEN rate IS NULL THEN rate"
  }
]);

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {readonly string[]} files @param {string} label */
function runLocalTests(files, label) {
  process.stdout.write(`\n[mutation] ${label}\n`);
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...files
  ], { env: process.env, stdio: "inherit" });
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Smart SCM PO OAuth mutations require the writable disposable MBT mutation container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map(await Promise.all(targets.map(async (target) => {
  const absolute = path.resolve(target);
  return /** @type {[string, { absolute: string, source: string }]} */ (
    [target, { absolute, source: await readFile(absolute, "utf8") }]
  );
})));
/** @param {string} target */
function originalFor(target) {
  const original = originals.get(target);
  if (!original) {
    throw new Error(`Missing mutation source snapshot: ${target}`);
  }
  return original;
}
const originalDigest = createHash("sha256");
for (const target of targets) {
  originalDigest.update(originalFor(target).source);
}
const expectedDigest = originalDigest.digest("hex");

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originalFor(mutant.target);
    if (occurrences(original.source, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    await writeFile(original.absolute, original.source.replace(mutant.from, mutant.to), "utf8");
    const result = mutant.database
      ? await runNodeTestFilesIsolated(mutant.tests, {
        environment: process.env,
        label: `PO OAuth mutant: ${mutant.name}`
      })
      : runLocalTests(mutant.tests, mutant.name);
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused regression.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(original.absolute, original.source, "utf8");
  }
} finally {
  for (const original of originals.values()) {
    await writeFile(original.absolute, original.source, "utf8");
  }
  const restored = createHash("sha256");
  for (const target of targets) {
    restored.update(await readFile(originalFor(target).absolute, "utf8"));
  }
  if (restored.digest("hex") !== expectedDigest) {
    throw new Error("Smart SCM PO OAuth mutation source restoration failed.");
  }
}

const localGreen = runLocalTests([
  REFERENCE_UNIT,
  FINANCIAL_UNIT,
  PURCHASE_REVIEW,
  VENDOR_UI,
  HISTORY_UI,
  HISTORY_CONTRACT,
  BLANKET_UI
], "post-mutation local green");
const databaseGreen = await runNodeTestFilesIsolated([HISTORY_DB], {
  environment: process.env,
  label: "PO OAuth post-mutation database green"
});
if (localGreen !== 0 || databaseGreen !== 0) {
  throw new Error("Smart SCM PO OAuth tests failed after restoring mutation sources.");
}
console.log(`Smart SCM PO OAuth mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
