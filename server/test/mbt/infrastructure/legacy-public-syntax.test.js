import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, "../../..");
const EXPECTED_FILES = Object.freeze([
  "public/login.js",
  "public/control.js",
  "public/operator.js",
  "public/app-sidebar.js",
  "public/dispatch-setup.js",
  "public/dispatch-special-stock.js",
  "public/dispatch.js",
  "public/driver-offline-photos.js",
  "public/driver-offline-sync.js",
  "public/driver-service-worker.js",
  "public/driver-location-override.js",
  "public/driver.js",
  "public/driver-bin-ui.js",
  "public/i18n.js",
  "public/mbt-assets.js",
  "public/mbt-billing.js",
  "public/mbt-frontdesk.js",
  "public/mbt-gates.js",
  "public/mbt-home.js",
  "public/mbt-shell.js",
  "public/sales-special-stock-requests.js",
  "public/scm-special-stock-requests.js"
]);

test("quality legacy seam: changed public scripts have an explicit gauntlet syntax check", async () => {
  const packageJson = JSON.parse(await readFile(path.join(serverRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["syntax:legacy"],
    "node test/support/check-legacy-public-syntax.mjs"
  );

  const gauntlet = await readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8");
  assert.match(gauntlet, /npm run syntax:legacy/);

  const syntaxModule = await import("../../support/check-legacy-public-syntax.mjs");
  assert.deepEqual(syntaxModule.LEGACY_PUBLIC_FILES, EXPECTED_FILES);
  assert.deepEqual(syntaxModule.checkLegacyPublicSyntax(), EXPECTED_FILES);

  const invalidRoot = await mkdtemp(path.join(os.tmpdir(), "mbt-legacy-syntax-"));
  try {
    const invalidFile = path.join(invalidRoot, "invalid.js");
    await writeFile(invalidFile, "function broken( {\n");
    assert.throws(
      () => syntaxModule.checkJavaScriptSyntax([invalidFile]),
      /JavaScript syntax check failed.*invalid\.js/i
    );
  } finally {
    await rm(invalidRoot, { recursive: true, force: true });
  }
});
