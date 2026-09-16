import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const directory = "test-artifacts/group-underpack-20260915", coverage = `${directory}/coverage`, results = [];
rmSync(coverage, { recursive: true, force: true }); mkdirSync(coverage, { recursive: true });
function run(name, args, covered = false) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 30e6,
    env: { ...process.env, NODE_V8_COVERAGE: covered ? coverage : "" } });
  if (result.error) {throw result.error;}
  writeFileSync(`${directory}/${name}.log`, result.stdout + result.stderr);
  results.push({ name, exitCode: result.status }); console.log(JSON.stringify(results.at(-1)));
  assert.equal(result.status, 0, `${name} failed`);
}
run("focused", ["tools/group-underpack-suite.mjs"], true);
run("static", ["tools/group-underpack-checks.mjs"]);
run("mutations", ["tools/group-underpack-mutations.mjs"]);
run("replay", ["tools/group-underpack-replay.mjs"], true);
copyFileSync(`${directory}/browser/coverage.json`, `${coverage}/browser.json`);
run("coverage-report", ["node_modules/c8/bin/c8.js", "report", "--all=false", "--check-coverage=false", `--temp-directory=${coverage}`,
  `--reports-dir=${directory}/c8`, "--include=src/delivery-packing-progress.js", "--include=src/delivery-repository.js", "--include=public/operator.js", "--include=public/service-worker.js",
  "--reporter=json", "--reporter=json-summary", "--reporter=text"]);
run("secrets", ["test/support/scan-diff-secrets.mjs", "src/delivery-packing-progress.js", "test/mbt/integration/group-underpack.test.js",
  "test/mbt/unit/group-underpack-ui.test.js", "test/support/group-underpack-fixture.mjs", "tools/group-underpack-checks.mjs",
  "tools/group-underpack-gauntlet.mjs", "tools/group-underpack-mutations.mjs", "tools/group-underpack-suite.mjs", "tools/group-underpack-browser.mjs",
  "tools/group-underpack-live.mjs", "tools/group-underpack-capture.mjs", "tools/group-underpack-replay.mjs"]);
writeFileSync(`${directory}/gauntlet.json`, JSON.stringify(results, null, 2) + "\n");
