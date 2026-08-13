// @ts-check

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const UNIT = "test/mbt/unit/smart-scm-vendor-unit-price.test.js";
const PROPERTY = "test/mbt/property/smart-scm-vendor-unit-price.property.test.js";
const UI = "src/smart-scm-vendor-ui-harness.js";
const INTEGRATION = "test/mbt/integration/smart-scm-vendor-unit-price.test.js";
const BLANKET = "src/smart-scm-blanket-workflow-harness.js";
const PO_FINANCIALS = "test/mbt/unit/smart-scm-vendor-po-financials.test.js";
const WEBHOOK_FINANCIALS = "test/mbt/unit/netsuite-order-webhook-financials.test.js";

const MUTANTS = Object.freeze([
  {
    name: "sub-six-decimal unit price is rounded down and saved as zero",
    target: "src/smart-scm-vendor-unit-price.js",
    tests: [UNIT, PROPERTY],
    from: "if (normalized <= 0) {",
    to: "if (normalized < 0) {"
  },
  {
    name: "maximum valid unit price is rejected",
    target: "src/smart-scm-vendor-unit-price.js",
    tests: [UNIT, PROPERTY],
    from: "if (parsed > SMART_SCM_VENDOR_UNIT_PRICE_MAX) {",
    to: "if (parsed >= SMART_SCM_VENDOR_UNIT_PRICE_MAX) {"
  },
  {
    name: "an omitted price silently clears the saved override",
    target: "src/smart-scm-vendor-unit-price.js",
    tests: [UNIT],
    from: "if (!Object.hasOwn(input || {}, \"unitPrice\")) {",
    to: "if (false && !Object.hasOwn(input || {}, \"unitPrice\")) {"
  },
  {
    name: "browser amount ignores the edited material price",
    target: "public/scm-smart-vendor.js",
    tests: [UI],
    from: "lastPurchasePrice: priceInput ? priceInput.value : row.dataset.lastPurchasePrice,",
    to: "lastPurchasePrice: row.dataset.lastPurchasePrice,"
  },
  {
    name: "PO review ignores the saved material price in favor of default sources",
    target: "src/smart-scm-vendor-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "const unitPrice = savedPrice ?? vendorPrice ?? lastPurchasePrice;",
    to: "const unitPrice = vendorPrice ?? lastPurchasePrice;"
  },
  {
    name: "saved PALLET price is discarded",
    target: "src/smart-scm-vendor-unit-price-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "item.purchase_unit, unitPrice]",
    to: "item.purchase_unit, null]"
  },
  {
    name: "direct Blanket split ignores edited material prices",
    target: "src/smart-scm-blanket-repository.js",
    tests: [BLANKET],
    database: true,
    from: "if (priceEdit.provided) {",
    to: "if (false && priceEdit.provided) {"
  },
  {
    name: "linked PO overlay accepts a right item from the wrong yard",
    target: "src/smart-scm-vendor-po-financials.js",
    tests: [PO_FINANCIALS],
    from: "if (proposal.itemId !== order.itemId || proposal.locationId !== order.locationId) return false;",
    to: "if (proposal.itemId !== order.itemId && proposal.locationId !== order.locationId) return false;"
  },
  {
    name: "linked PO overlay keeps the stale Vendor Reply price",
    target: "src/smart-scm-vendor-po-financials.js",
    tests: [PO_FINANCIALS],
    from: "lastPurchasePrice: rate,",
    to: "lastPurchasePrice: confirmedPrice,"
  },
  {
    name: "webhook receiver discards the sender's PO rate",
    target: "src/netsuite-order-webhook-financials.js",
    tests: [WEBHOOK_FINANCIALS],
    from: "rate: source.rate ?? source.unitPrice ?? source.unit_price,",
    to: "rate: undefined,"
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
  throw new Error("Vendor unit-price mutations require the writable disposable MBT mutation container.");
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
    const status = mutant.database
      ? await runNodeTestFilesIsolated(mutant.tests, {
        environment: process.env,
        label: `Vendor unit-price mutant: ${mutant.name}`
      })
      : runLocalTests(mutant.tests, mutant.name);
    if (status === 0) {
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
    throw new Error("Vendor unit-price mutation source restoration failed.");
  }
}

const localGreen = runLocalTests(
  [UNIT, PROPERTY, PO_FINANCIALS, WEBHOOK_FINANCIALS, UI],
  "post-mutation local green"
);
const databaseGreen = await runNodeTestFilesIsolated([INTEGRATION, BLANKET], {
  environment: process.env,
  label: "Vendor unit-price post-mutation database green"
});
if (localGreen !== 0 || databaseGreen !== 0) {
  throw new Error("Vendor unit-price regressions failed after restoring mutation sources.");
}
console.log(`Vendor unit-price mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);
