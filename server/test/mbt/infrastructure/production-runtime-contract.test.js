import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, "../../..");

const FROZEN_PRODUCTION_ROOTS = Object.freeze({
  "@ericblade/quagga2": "^1.12.1",
  dotenv: "^16.4.5",
  exceljs: "^4.4.0",
  express: "^4.19.2",
  pg: "^8.11.5",
  "qr-scanner": "^1.4.2",
  sharp: "0.35.3"
});

test("quality non-regression: production roots stay frozen and security patches are explicit", async () => {
  const packageJson = JSON.parse(await readFile(path.join(serverRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(serverRoot, "package-lock.json"), "utf8"));

  assert.deepEqual(packageJson.dependencies, FROZEN_PRODUCTION_ROOTS);
  assert.deepEqual(packageJson.overrides["minimatch@3.1.5"], {
    "brace-expansion": "1.1.18"
  });
  assert.deepEqual(packageJson.overrides["minimatch@5.1.9"], {
    "brace-expansion": "2.1.4"
  });
  assert.equal(
    packageLock.packages["node_modules/minimatch/node_modules/brace-expansion"].version,
    "1.1.18"
  );
  assert.equal(
    packageLock.packages["node_modules/readdir-glob/node_modules/brace-expansion"].version,
    "2.1.4"
  );
});

test("quality non-regression: the gauntlet builds and validates the omit-dev runtime", async () => {
  const gauntlet = await readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8");
  const dockerfile = await readFile(path.join(serverRoot, "Dockerfile"), "utf8");
  assert.match(gauntlet, /build test mutation app/);
  assert.match(gauntlet, /npm ls --omit=dev --all/);
  assert.match(gauntlet, /MBT_PREDEPLOY_READ_ONLY=1/);
  assert.match(gauntlet, /npm run preflight:mbt-p1-deploy/);
  assert.match(gauntlet, /--profile runtime[\s\\]+--profile e2e[\s\\]+build e2e/);
  assert.match(gauntlet, /--profile runtime[\s\\]+--profile e2e[\s\\]+run --rm e2e/);
  assert.match(dockerfile, /COPY tools\/mbt-predeploy-readiness\.mjs \.\/tools\/mbt-predeploy-readiness\.mjs/);
});
