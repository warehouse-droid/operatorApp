// @ts-check

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const TEST_FILE = "test/mbt/integration/driver-direct-pickup-online-offline.test.js";

if (process.env.MBT_TEST_ISOLATED !== "1") {
  throw new Error("The direct terminal lifecycle requires the isolated disposable test database.");
}

for (const mode of ["online", "offline"]) {
  const result = await runNodeTestFilesIsolated([TEST_FILE], {
    environment: {
      ...process.env,
      DIRECT_PICKUP_REPRO_MODE: mode
    },
    label: `Direct pickup terminal lifecycle (${mode})`
  });
  if (result !== 0) {
    process.exitCode = result;
    break;
  }
}
