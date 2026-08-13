// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const PROPERTY = "test/mbt/property/stock-request-domain.property.test.js";
const POLICY = "test/mbt/unit/stock-request-policy.test.js";
const FEATURE_CATALOG = "test/mbt/unit/feature-gate-catalog.test.js";
const SERVICE = "test/mbt/unit/stock-request-service.test.js";
const UI = "test/mbt/unit/stock-request-ui-contract.test.js";
const INTEGRATION = "test/mbt/integration/stock-request-repository.test.js";
const ADVERSARIAL_DB = "test/mbt/adversarial/stock-request-repository-adversarial.test.js";

const MUTANTS = Object.freeze([
  {
    name: "conversion arithmetic drops unit multipliers",
    target: "src/stock-request-domain.js",
    tests: [PROPERTY],
    propertyOnly: true,
    from: "sum + (value * (conversions[key] || 0))",
    to: "sum + value"
  },
  {
    name: "reserved stock is added instead of deducted",
    target: "src/stock-request-domain.js",
    tests: [PROPERTY],
    propertyOnly: true,
    from: "return Math.max(0, live - (Number.isFinite(reserved) && reserved > 0 ? reserved : 0));",
    to: "return Math.max(0, live + (Number.isFinite(reserved) && reserved > 0 ? reserved : 0));"
  },
  {
    name: "a pending TO cannot reclaim its own reservation when calculating backorder",
    target: "src/stock-request-domain.js",
    tests: [PROPERTY],
    propertyOnly: true,
    from: "(Number.isFinite(reserved) ? reserved : 0) - (Number.isFinite(own) ? own : 0)",
    to: "(Number.isFinite(reserved) ? reserved : 0) + (Number.isFinite(own) ? own : 0)"
  },
  {
    name: "backorder shortage is always hidden",
    target: "src/stock-request-domain.js",
    tests: [PROPERTY],
    propertyOnly: true,
    from: "backorderQuantity: Math.max(0, normalizedRequested - requestableAvailable)",
    to: "backorderQuantity: 0"
  },
  {
    name: "route grouping ignores destination yard",
    target: "src/stock-request-domain.js",
    tests: [PROPERTY],
    propertyOnly: true,
    from: "const key = `${sourceLocationId}:${destinationLocationId}`;",
    to: "const key = `${sourceLocationId}:1`;"
  },
  {
    name: "PALLET remainder is rounded down",
    target: "src/stock-request-domain.js",
    tests: [PROPERTY],
    propertyOnly: true,
    from: "sum + Math.ceil(item.salesQty / item.toPlt)",
    to: "sum + Math.floor(item.salesQty / item.toPlt)"
  },
  {
    name: "Admin catalog omits the Sales over-availability gate",
    target: "src/mbt/feature-gate-catalog.js",
    tests: [FEATURE_CATALOG],
    from: "flagKey: \"sales_stock_request_over_availability\",",
    to: "flagKey: \"sales_stock_request_over_availability_removed\","
  },
  {
    name: "missing Admin over-availability gate fails open",
    target: "src/stock-request-policy.js",
    tests: [POLICY],
    from: "allowOverAvailability: row?.enabled === true,",
    to: "allowOverAvailability: row?.enabled !== false,"
  },
  {
    name: "bounded Sales requests ignore current availability",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "if (allowOverAvailability !== true && requested > available + 1e-9) {",
    to: "if (false && requested > available + 1e-9) {"
  },
  {
    name: "backorder snapshot ignores other active reservations",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "activeReserved: reservations.get(key) || 0,\n      ownReserved: ownReservations.get(key) || 0",
    to: "activeReserved: 0,\n      ownReserved: ownReservations.get(key) || 0"
  },
  {
    name: "SCM line entry still blocks quantities above availability",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "await assertCachedAvailability([normalized], { allowOverAvailability: true });",
    to: "await assertCachedAvailability([normalized]);"
  },
  {
    name: "SCM conversion rejects any calculated backorder",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION, ADVERSARIAL_DB],
    database: true,
    from: "snapshot.push({\n      itemId: pair.itemId,",
    to: "if (backorder.backorderQuantity > 0) throw stockRequestError(\"Backorder blocked mutant.\", 409);\n    snapshot.push({\n      itemId: pair.itemId,"
  },
  {
    name: "audited backorder quantity is discarded",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "backorderSalesQty: backorder.backorderQuantity",
    to: "backorderSalesQty: 0"
  },
  {
    name: "failed confirmation permanently owns the retry key",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "&& ![\"complete\", \"attention\"].includes(transfer.confirmationStatus))",
    to: "&& transfer.confirmationStatus !== \"complete\")"
  },
  {
    name: "quantity revision leaves the stale ticket active",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "print_job_id = NULL, confirmation_status = CASE WHEN netsuite_transfer_order_id IS NULL THEN confirmation_status ELSE 'attention' END,",
    to: "confirmation_status = CASE WHEN netsuite_transfer_order_id IS NULL THEN confirmation_status ELSE 'attention' END,"
  },
  {
    name: "cancelled NetSuite TO keeps inventory reserved",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "if ([\"received\", \"cancelled\", \"closed\"].includes(projected)) {",
    to: "if (projected === \"received\") {"
  },
  {
    name: "returned request line cannot be converted by SCM",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "locked.rows.some((line) => !EDITABLE_LINE_STATUSES.has(line.status))",
    to: "locked.rows.some((line) => line.status !== \"submitted\")"
  },
  {
    name: "confirmed TO can be rejected locally",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "const isPristineLocalTransfer = transfer.status === \"pending_local\"",
    to: "const isPristineLocalTransfer = true || transfer.status === \"pending_local\""
  },
  {
    name: "NetSuite Closed is ignored",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "if (/\\bclosed\\b/i.test(`${status} ${statusText}`)) return \"closed\";",
    to: "if (false) return \"closed\";"
  },
  {
    name: "completed accepted request disappears from Sales history",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "|| requestedBucket === \"accepted\"",
    to: "|| false"
  },
  {
    name: "rejected local Pending TO leaks into Sales Accepted history",
    target: "src/stock-request-repository.js",
    tests: [INTEGRATION],
    database: true,
    from: "AND (\n           bucket_transfer.status <> 'cancelled'\n           OR bucket_transfer.netsuite_transfer_order_id IS NOT NULL\n         )",
    to: "AND TRUE"
  },
  {
    name: "completed confirmation retries print twice",
    target: "src/stock-request-service.js",
    tests: [SERVICE],
    from: "&& transfer?.printJobId) {",
    to: "&& false) {"
  },
  {
    name: "Sales stock requests allow public portal identity",
    target: "public/sales-stock-requests.js",
    tests: [UI],
    from: "allowPublicSales: false,",
    to: "allowPublicSales: true,"
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
  throw new Error("Stock-request mutations require the writable disposable MBT mutation container.");
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
let propertyKilled = 0;
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
        label: `Stock-request mutant: ${mutant.name}`
      })
      : runLocalTests(mutant.tests, mutant.name);
    if (status === 0) {
      throw new Error(`${mutant.name}: survived its focused regression.`);
    }
    killed += 1;
    if (mutant.propertyOnly) {
      propertyKilled += 1;
    }
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(original.absolute, original.source, "utf8");
  }
} finally {
  for (const original of originals.values()) {
    await writeFile(original.absolute, original.source, "utf8");
  }
  const restoredDigest = createHash("sha256");
  for (const target of targets) {
    restoredDigest.update(await readFile(originalFor(target).absolute, "utf8"));
  }
  if (restoredDigest.digest("hex") !== expectedDigest) {
    throw new Error("Stock-request mutation source restoration failed.");
  }
}

const localGreen = runLocalTests([PROPERTY, POLICY, FEATURE_CATALOG, SERVICE, UI], "stock-request post-mutation local green");
const databaseGreen = await runNodeTestFilesIsolated([INTEGRATION, ADVERSARIAL_DB], {
  environment: process.env,
  label: "Stock-request post-mutation database green"
});
if (localGreen !== 0 || databaseGreen !== 0) {
  throw new Error("Stock-request regressions failed after restoring mutation sources.");
}
const propertyMutantCount = MUTANTS.filter((mutant) => mutant.propertyOnly).length;
console.log(`Stock-request mutation score: ${killed}/${MUTANTS.length} killed (100%); property-only: ${propertyKilled}/${propertyMutantCount} killed; source restored.`);
