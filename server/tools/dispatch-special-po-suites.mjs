import path from "node:path";
import { readFile } from "node:fs/promises";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const files = [...new Set([
  ...["test:dispatch-po-route-residual", "test:scm-dependency-management"].flatMap((key) =>
    pkg.scripts[key].split(" ").filter((part) => /\.(js|mjs)$/u.test(part))),
  "test/dispatch/unit/dispatch-special-po-lifecycle.test.js",
  "test/dispatch/property/dispatch-special-po-lifecycle.test.js",
  "test/dispatch/integration/dispatch-special-po-lifecycle.test.js",
  "test/dispatch/unit/dispatch-history-mode.test.js",
  "test/dispatch/integration/dispatch-reconciliation-completed-planning.red.test.js",
  "test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js",
  "test/dispatch/frontend/dispatch-completion-ui.test.js",
  "test/mbt/integration/dispatch-completion-status.red.test.js",
  "test/mbt/integration/dispatch-completion-migration.test.js",
  "test/mbt/integration/dispatch-completion-http.red.test.js",
  "test/mbt/concurrency/dispatch-completion-races.test.js"
])];
if (process.argv.includes("random")) {
  let seed = 35925;
  for (let i = files.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [files[i], files[j]] = [files[j], files[i]];
  }
}
const requested = process.argv.slice(2).filter((arg) => arg !== "random");
process.exitCode = await runNodeTestFilesIsolated((requested.length ? requested : files).map((file) => path.resolve(file)), {
  environment: buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }), label: "Special PO lifecycle"
});
