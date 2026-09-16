import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const artifact = "test-artifacts/split-address";
const files = ["src/dispatch-delivery-group-repository.js", "src/delivery-repository.js", "src/dispatch-repository.js",
  "src/dispatch-planner-optimization.js", "public/dispatch.js"];
const commands = [
  ["coverage-final", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false", ...files.map(file => `--include=${file}`),
    `--temp-directory=${artifact}/coverage-tmp`, `--reports-dir=${artifact}/coverage`, "--reporter=json", "--reporter=text",
    process.execPath, "tools/dispatch-split-address-coverage-run.mjs"]],
  ["changed-coverage-final", ["tools/dispatch-split-address-coverage.mjs"]],
  ["mutations-final", ["tools/dispatch-split-address-mutations.mjs"]],
  ["static-final", ["tools/dispatch-split-address-static.mjs"]],
  ["lint-final", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js", "--max-warnings=0",
    ...["frontend", "integration", "unit"].map(group => `test/dispatch/${group}/dispatch-split-address.test.js`),
    "test/dispatch/integration/dispatch-split-address-http.test.js", "test/dispatch/support/split-address-fixture.js",
    "tools/dispatch-split-address-mutations.mjs", "tools/dispatch-split-address-static.mjs", "tools/dispatch-split-address-checks.mjs",
    "tools/dispatch-split-address-files.mjs", "tools/dispatch-split-address-suite.mjs", "tools/dispatch-split-address-coverage-run.mjs"]]
];
for (const [name, args] of commands) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 20e6 });
  writeFileSync(`${artifact}/${name}.log`, `${result.stdout}${result.stderr}`);
  console.log(JSON.stringify({ name, exitCode: result.status }));
  assert.equal(result.status, 0, `See ${artifact}/${name}.log`);
}
