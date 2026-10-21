import path from "node:path";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const files = [
  "test/dispatch/unit/dispatch-executed-order-review.test.js",
  "test/dispatch/unit/dispatch-executed-order-incidents.test.js",
  "test/dispatch/property/dispatch-executed-order-review.test.js",
  "test/dispatch/integration/dispatch-executed-order-review.test.js",
  "test/dispatch/frontend/dispatch-executed-order-review.browser.test.mjs",
  "test/dispatch/unit/dispatch-command-matrix.test.js",
  "test/dispatch/unit/dispatch-split-address.test.js",
  "test/dispatch/frontend/dispatch-stale-address.test.js",
  "test/dispatch/frontend/dispatch-split-address.test.js",
  "test/dispatch/frontend/dispatch-split-address.browser.test.mjs",
  "test/dispatch/frontend/dispatch-po-delivery-address-override.contract.test.js",
  "test/dispatch/integration/dispatch-po-delivery-address-override.red.test.js",
  "test/dispatch/integration/dispatch-recorded-po-load.test.js",
  "test/dispatch/integration/dispatch-retired-confirm-timing.test.js",
  "test/mbt/unit/group-action-ui.test.js",
  "test/mbt/integration/group-action-fix.test.js",
  "test/mbt/integration/group-action-http.test.js",
  "test/mbt/unit/driver-live-route-prefix-lock.red.test.js",
  "test/mbt/unit/driver-live-route-prefix-lock-wiring.contract.test.js",
  "test/mbt/unit/driver-offline-route-cursor.red.test.js",
  "test/mbt/property/driver-live-route-prefix-lock.property.test.js",
  "test/mbt/adversarial/driver-live-route-prefix-lock.adversarial.test.js",
  "test/mbt/integration/driver-live-route-prefix-lock.integration.test.js",
  "test/mbt/concurrency/driver-live-route-prefix-lock.concurrency.test.js"
];
if (process.argv.includes("random")) {
  let seed = 2092026;
  for (let i = files.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [files[i], files[j]] = [files[j], files[i]];
  }
}
process.exitCode = await runNodeTestFilesIsolated(files.map(file => path.resolve(file)), {
  environment: buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }), label: "Executed source review"
});
