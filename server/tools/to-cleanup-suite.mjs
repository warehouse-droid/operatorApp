import { readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";
async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(file));
    else if (/\.test\.(?:js|mjs)$/u.test(entry.name) && !entry.name.startsWith("to-cleanup")) files.push(file);
  }
  return files;
}
const focused = process.argv[2] === "focused";
const files = focused ? ["test/dispatch/unit/to-cleanup.test.js", "test/dispatch/integration/to-cleanup-apply.test.js",
  "test/dispatch/integration/to-cleanup-planning.test.js", "test/dispatch/integration/to-cleanup-http.test.js",
  "test/dispatch/integration/dispatch-reconciliation-completed-planning.red.test.js", "test/dispatch/integration/dispatch-fulfilled-so-planning.test.js",
  "test/dispatch/integration/dispatch-fulfilled-so-http.test.js", "test/dispatch/unit/co-source-group-cleanup.test.js",
  "test/dispatch/unit/local-co-loaded.test.js", "test/mbt/unit/delivery-instruction-contract.test.js"] : [];
if (!focused) for (const group of ["unit", "integration", "property", "adversarial", "concurrency"]) files.push(...await collect(path.resolve("test/dispatch", group)));
const seed = "20260915";
const rank = file => createHash("sha256").update(seed + file).digest("hex");
files.sort(focused ? (a, b) => rank(a).localeCompare(rank(b)) : undefined);
console.log(JSON.stringify({ files: files.length, scope: focused ? "focused" : "existing-dispatch-regression", shuffleSeed: focused ? seed : null }));
process.exitCode = await runNodeTestFilesIsolated(files, { environment: {
  ...buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }), NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE || ""
}, label: focused ? "TO cleanup focused" : "TO cleanup Dispatch regression" });
