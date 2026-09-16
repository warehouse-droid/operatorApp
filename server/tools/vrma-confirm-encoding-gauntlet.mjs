import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const directory = "test-artifacts/vrma-confirm-encoding-20260915", coverage = `${directory}/coverage`, results = [];
rmSync(coverage, { recursive: true, force: true }); mkdirSync(coverage, { recursive: true });
function run(name, args, covered = false) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 30e6,
    env: { ...process.env, NODE_V8_COVERAGE: covered ? coverage : "" } });
  if (result.error) {throw result.error;}
  writeFileSync(`${directory}/${name}.log`, result.stdout + result.stderr);
  results.push({ name, exitCode: result.status }); console.log(JSON.stringify(results.at(-1)));
  assert.equal(result.status, 0, `${name} failed`);
}
run("focused", ["tools/vrma-confirm-encoding-suite.mjs"], true);
run("legacy-vrma", ["src/scm-vrma-harness.js"], true);
run("static", ["tools/vrma-confirm-encoding-checks.mjs"]);
run("mutations", ["tools/vrma-confirm-encoding-mutations.mjs"]);
run("coverage-report", ["node_modules/c8/bin/c8.js", "report", "--all=false", "--check-coverage=false", `--temp-directory=${coverage}`,
  `--reports-dir=${directory}/c8`, "--include=src/operator-yard-route.js", "--include=src/operator-yard-authorization.js",
  "--reporter=json", "--reporter=json-summary", "--reporter=text"]);
run("secrets", ["test/support/scan-diff-secrets.mjs", "src/operator-yard-route.js", "test/mbt/unit/vrma-confirm-encoding.test.js",
  "test/mbt/integration/vrma-confirm-encoding.test.js", "tools/vrma-confirm-encoding-checks.mjs", "tools/vrma-confirm-encoding-gauntlet.mjs",
  "tools/vrma-confirm-encoding-mutations.mjs", "tools/vrma-confirm-encoding-suite.mjs"]);
writeFileSync(`${directory}/gauntlet.json`, JSON.stringify(results, null, 2) + "\n");
