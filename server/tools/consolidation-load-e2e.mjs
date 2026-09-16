import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { app } from "../src/server.js";
import { closeDb } from "../src/db.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const server = app.listen(3000, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
try {
  const child = spawn("node_modules/.bin/playwright", ["test", "--config", "test/consolidation-load.playwright.config.mjs",
    "test/mbt/e2e/operator-ui-enhancements.spec.js", "test/mbt/e2e/operator-page-confirm.spec.js",
    "test/mbt/e2e/operator-customer-pickup-photo-gate.spec.js", "test/mbt/e2e/operator-fulfillment-long-group-layout.spec.js"], {
    stdio: "inherit", env: { ...process.env, MBT_TEST_BASE_URL: "http://127.0.0.1:3000", NODE_V8_COVERAGE: "" }
  });
  process.exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
} finally {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
}
