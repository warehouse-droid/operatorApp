import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mutants } from "../test/support/packed-group-mutation-loader.mjs";

const artifact = "test-artifacts/packed-group-review";
const regression = "test/dispatch/integration/dispatch-packed-group-review.test.js";
await mkdir(artifact, { recursive: true });
await rm(`${artifact}/checks.json`, { force: true });
const hash = value => createHash("sha256").update(value).digest("hex");
const sourceSha256 = hash(await readFile("src/dispatch-plan-repository.js"));
function run(args, environment = {}) {
  return spawnSync(process.execPath, args, {
    env: { ...process.env, ...environment }, encoding: "utf8", maxBuffer: 15 * 1024 * 1024
  });
}
async function checked(name, args) {
  const result = run(args);
  await writeFile(`${artifact}/${name}.log`, result.stdout + result.stderr);
  assert.equal(result.status, 0, `${name} failed; inspect its log`);
  return result;
}
const adjacent = [
  regression,
  "src/grouped-sales-order-reconciliation-integration-harness.js",
  "src/grouped-po-reconciliation-integration-harness.js",
  "src/sales-order-reconciliation-policy-harness.js",
  "src/dispatch-group-reconciliation-ui-harness.js",
  "test/dispatch/integration/dispatch-global-order-group-pool.red.test.js",
  "test/dispatch/property/dispatch-global-order-group-pool.property.test.js"
];
const legacy = ["src/sales-order-reconciliation-harness.js",
  "src/sales-order-reconciliation-integration-harness.js",
  "test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js"];
const legacyFailures = [];
for (const baseline of [true, false]) {
  const result = run(["--experimental-loader", "./test/support/packed-group-mutation-loader.mjs",
    "--test", "--test-concurrency=1", ...legacy], { PACKED_GROUP_BASELINE: baseline ? "1" : "0" });
  const output = result.stdout + result.stderr;
  await writeFile(`${artifact}/legacy-${baseline ? "baseline" : "final"}.log`, output);
  const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
  assert.equal(failures.length, 4, "Unexpected legacy failure count; inspect the log");
  legacyFailures.push(failures);
}
assert.deepEqual(legacyFailures[1], legacyFailures[0], "No new legacy regressions allowed");
await checked("focused", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
  "--include=src/dispatch-plan-repository.js", `--report-dir=${artifact}/coverage`,
  `--temp-directory=/tmp/packed-group-c8-${process.pid}`, "--reporter=json", "--reporter=text",
  process.execPath, "--test", "--test-concurrency=1", ...adjacent]);
// Separate invocations enforce the requested order; node --test sorts its inputs.
for (const [index, file] of adjacent.toReversed().entries()) {
  await checked(`reverse-${index}`, ["--test", "--test-concurrency=1", file]);
}
const kills = [];
for (const name of Object.keys(mutants)) {
  const result = run(["--experimental-loader", "./test/support/packed-group-mutation-loader.mjs",
    "--test", "--test-concurrency=1", regression], { PACKED_GROUP_MUTANT: name });
  const output = result.stdout + result.stderr;
  await writeFile(`${artifact}/mutant-${name}.log`, output);
  assert.notEqual(result.status, 0, `${name} survived`);
  assert.match(output, /ERR_ASSERTION/, `${name} must fail behavior, not loading or setup`);
  assert.doesNotMatch(output, /Mutation anchor must occur exactly once/);
  kills.push(name);
}
await checked("final-focused", ["--test", "--test-concurrency=1", ...adjacent]);
await checked("syntax", ["--check", "src/dispatch-plan-repository.js"]);
await checked("lint-source", ["node_modules/eslint/bin/eslint.js", "--config",
  "tools/eslint.so-reconciliation.config.js", "--max-warnings=0", "src/dispatch-plan-repository.js"]);
await checked("lint-tests", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js",
  "--max-warnings=0", regression, "test/support/packed-group-mutation-loader.mjs",
  "tools/dispatch-packed-group-checks.mjs", "tools/refresh-dispatch-packed-group-reviews.mjs"]);
await checked("secrets", ["test/support/scan-diff-secrets.mjs", "src/dispatch-plan-repository.js",
  regression, "test/support/packed-group-mutation-loader.mjs", "tools/dispatch-packed-group-checks.mjs",
  "tools/dispatch-packed-group-test.sh", "test/dispatch-packed-group-review-spec.md",
  "tools/refresh-dispatch-packed-group-reviews.mjs"]);
const coverage = JSON.parse(await readFile(`${artifact}/coverage/coverage-final.json`, "utf8"));
const target = Object.values(coverage).find(entry => entry.path.endsWith("/src/dispatch-plan-repository.js"));
const lines = String(await readFile("src/dispatch-plan-repository.js")).split("\n");
const changedLines = [lines.findIndex(line => line.includes('|| operatorStatus === "preparing"')) + 1,
  lines.findIndex(line => line.includes('|| (operatorStatus !== "packed" &&')) + 1];
assert.ok(changedLines.every(line => Object.entries(target.statementMap).some(([id, loc]) =>
  loc.start.line <= line && loc.end.line >= line && target.s[id] > 0)), "Changed conditions must execute");
assert.equal(hash(await readFile("src/dispatch-plan-repository.js")), sourceSha256);
const result = { sourceSha256, mutationKills: kills, changedLines, changedLineCoverage: 1,
  preexistingLegacyFailures: legacyFailures[1] };
await writeFile(`${artifact}/checks.json`, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
