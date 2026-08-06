import { expect, test as playwrightTest } from "@playwright/test";

import { closeDb } from "../../../src/db.js";

export const test = playwrightTest.extend({
  mbtDatabasePoolLifecycle: [async ({ browserName }, use) => {
    if (!browserName) {
      throw new Error("The MBT E2E worker requires an explicit browser project.");
    }
    try {
      await use();
    } finally {
      await closeDb();
    }
  }, { auto: true, scope: "worker" }]
});

export { expect };
