import { createHash } from "node:crypto";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";
const files = ["test/mbt/unit/vrma-confirm-encoding.test.js", "test/mbt/integration/vrma-confirm-encoding.test.js",
  "test/mbt/unit/operator-yard-access.test.js", "test/mbt/integration/operator-yard-access.test.js",
  "test/mbt/integration/operator-page-confirm.red.test.js", "test/mbt/integration/operator-receiving-identity.test.js",
  "test/mbt/integration/consolidation-load.test.js"];
const seed = "20260915", rank = file => createHash("sha256").update(seed + file).digest("hex");
files.sort((a, b) => rank(a).localeCompare(rank(b)));
console.log(JSON.stringify({ files: files.length, shuffleSeed: seed }));
process.exitCode = await runNodeTestFilesIsolated(files, { label: "VRMA encoding and yard authorization", environment: {
  ...buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }), NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE || ""
} });
