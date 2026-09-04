// @ts-check

import { spawnSync } from "node:child_process";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";
import { buildIsolatedTestEnvironment } from "./test-foundation.mjs";

const UNIT_TESTS = Object.freeze([
  "test/dispatch/unit/dispatch-assignment-projection-self-heal.contract.test.js"
]);
const DATABASE_TESTS = Object.freeze([
  "test/dispatch/integration/dispatch-po-ref-projection-consistency.red.test.js",
  "test/dispatch/integration/dispatch-assignment-readiness-invariant.red.test.js",
  "test/mbt/integration/scm-schedule-status-concurrency.test.js",
  "test/dispatch/integration/scm-po-split-editing.test.js",
  "test/dispatch/integration/dispatch-order-catalog.red.test.js",
  "test/dispatch/integration/dispatch-v2-command-flow.red.test.js",
  "test/dispatch/integration/dispatch-planner-compact-command.red.test.js"
]);

if (process.env.MBT_TEST_ISOLATED !== "1") {
  throw new Error("Dispatch PO-reference projection tests require the isolated disposable database.");
}

const databaseUrl = String(process.env.DATABASE_URL || "");
const environment = {
  ...buildIsolatedTestEnvironment(process.env, { databaseUrl }),
  DISPATCH_PLANNER_ORDER_POOL_MODE: "on"
};
const unit = spawnSync(process.execPath, [
  "--test",
  "--test-concurrency=1",
  ...UNIT_TESTS
], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit"
});
if (unit.error) {
  throw unit.error;
}
if ((unit.status ?? 1) !== 0) {
  process.exit(unit.status ?? 1);
}

process.exitCode = await runNodeTestFilesIsolated([...DATABASE_TESTS], {
  environment,
  label: "Dispatch PO-reference projection consistency"
});
