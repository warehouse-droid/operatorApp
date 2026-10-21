import crypto from "node:crypto";
import fs from "node:fs";
import {test as base, expect} from "../mbt/e2e/mbt-e2e-test.js";

export {expect};
export const test = base.extend({
  driverUploadCoverage: [async ({page, browserName}, use) => {
    if (browserName === "chromium") await page.coverage.startJSCoverage({resetOnNavigation: false});
    await use();
    if (browserName === "chromium") {
      const entries = (await page.coverage.stopJSCoverage()).filter(entry => /\/driver(?:-upload)?\.js\?/u.test(entry.url));
      const directory = `test-artifacts/browser-coverage/${process.env.DRIVER_UPLOAD_TEST_PHASE || "browser"}`;
      fs.mkdirSync(directory, {recursive: true});
      fs.writeFileSync(`${directory}/${crypto.randomUUID()}.json`, JSON.stringify(entries));
    }
  }, {auto: true}]
});
