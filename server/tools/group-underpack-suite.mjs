import { createHash } from "node:crypto";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";
const files = ["test/mbt/integration/group-underpack.test.js", "test/mbt/unit/group-underpack-ui.test.js",
  "test/dispatch/property/group-underpack-boundary.property.test.js",
  "test/mbt/unit/operator-yard-assets.test.js",
  "test/mbt/integration/operator-linked-quantity-repository.red.test.js", "test/mbt/integration/consolidation-load.test.js",
  "test/mbt/integration/operator-page-confirm.red.test.js", "test/mbt/integration/operator-customer-pickup-photo-gate.red.test.js",
  "test/mbt/property/sales-order-reattempt-quantity.property.test.js", "test/mbt/unit/operator-ui-enhancements.test.js"];
const seed = "20260915", rank = file => createHash("sha256").update(seed + file).digest("hex");
files.sort((a, b) => rank(a).localeCompare(rank(b)));
console.log(JSON.stringify({ files: files.length, shuffleSeed: seed }));
process.exitCode = await runNodeTestFilesIsolated(files, { label: "Delivery packing rounding", environment: {
  ...buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }), NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE || ""
} });
