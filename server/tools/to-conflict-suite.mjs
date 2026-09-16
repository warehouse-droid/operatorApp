import { createHash } from "node:crypto";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";
const files = ["test/dispatch/unit/to-conflict-cleanup.test.js", "test/dispatch/integration/to-conflict-cleanup.test.js",
  "test/dispatch/unit/to-cleanup.test.js", "test/dispatch/integration/to-cleanup-apply.test.js", "test/dispatch/integration/to-cleanup-planning.test.js",
  "test/dispatch/integration/to-cleanup-http.test.js", "test/dispatch/integration/dispatch-fulfilled-so-planning.test.js",
  "test/dispatch/integration/dispatch-fulfilled-so-http.test.js", "test/dispatch/integration/dispatch-reconciliation-completed-planning.red.test.js",
  "test/dispatch/unit/co-source-group-cleanup.test.js", "test/dispatch/unit/local-co-loaded.test.js"];
const rank = value => createHash("sha256").update(`20260915:${value}`).digest("hex");
files.sort((a, b) => rank(a).localeCompare(rank(b)));
console.log(JSON.stringify({ files: files.length, shuffleSeed: 20260915 }));
process.exitCode = await runNodeTestFilesIsolated(files, { environment: {
  ...buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }), NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE || ""
}, label: "TO authoritative conflict" });
