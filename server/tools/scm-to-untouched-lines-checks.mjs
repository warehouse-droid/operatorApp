import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mutants } from "../test/support/scm-to-untouched-lines-loader.mjs";

const artifact = "test-artifacts/scm-to-untouched-lines";
const sourceFile = "src/scm-dependency-preview-service.js";
const testFile = "test/dispatch/integration/scm-to-untouched-lines.test.js";
const source = await readFile(sourceFile, "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
await mkdir(artifact, { recursive: true });
const adjacent = [testFile,
  "test/dispatch/integration/scm-dependency-preview-blockers.red.test.js",
  "test/dispatch/integration/order-dependency-multi-to-extension.red.test.js",
  "test/dispatch/integration/transfer-completed-unlink.test.js",
  "test/dispatch/property/order-dependency-quantity.property.test.js",
  "test/mbt/unit/scm-dependency-management-policy.red.test.js",
  "test/mbt/unit/scm-dependency-command-service.red.test.js"];

async function run(name, args, environment = {}, allowFailure = false) {
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, ...environment }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    timeout: 180000
  });
  const output = result.stdout + result.stderr;
  await writeFile(`${artifact}/${name}.log`, output);
  if (!allowFailure) {assert.equal(result.status, 0, `${name} failed; inspect ${artifact}/${name}.log`);}
  return { ...result, output };
}

await run("coverage", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
  `--include=${sourceFile}`, `--report-dir=${artifact}/coverage`, `--temp-directory=/tmp/scm-to-c8-${process.pid}`,
  "--reporter=json", "--reporter=text", process.execPath, "--test", "--test-concurrency=1", ...adjacent]);
const kills = [];
const propertyKills = [];
const propertySurvivors = [];
for (const name of Object.keys(mutants)) {
  const args = ["--experimental-loader", "./test/support/scm-to-untouched-lines-loader.mjs", "--test"];
  const result = await run(`mutant-${name}`, [...args, testFile], { SCM_TO_MUTANT: name }, true);
  assert.notEqual(result.status, 0, `${name} survived`);
  assert.match(result.output, /ERR_ASSERTION|Property failed after/u, `${name} must fail a behavioral assertion`);
  assert.doesNotMatch(result.output, /Invalid mutation anchor|SyntaxError|ERR_MODULE_NOT_FOUND/u);
  kills.push(name);
  const property = await run(`property-mutant-${name}`, [...args, "--test-name-pattern=generated", testFile], { SCM_TO_MUTANT: name }, true);
  if (property.status !== 0) {
    assert.match(property.output, /Property failed after/u);
    propertyKills.push(name);
  } else {propertySurvivors.push(name);}
}
// Node sorts file arguments; separate invocations enforce the reverse order.
for (const [index, file] of adjacent.toReversed().entries()) {
  await run(`reverse-${index}`, ["--test", file]);
}
const focused = await run("final-focused", ["--test", "--test-concurrency=1", ...adjacent]);
await run("syntax", ["--check", sourceFile]);
await run("lint", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js", "--max-warnings=0",
  sourceFile, testFile, "tools/scm-to-untouched-lines-checks.mjs", "test/support/scm-to-untouched-lines-loader.mjs",
  "tools/scm-to-untouched-lines-live.mjs"]);
await run("secrets", ["test/support/scan-diff-secrets.mjs", sourceFile, testFile,
  "tools/scm-to-untouched-lines-checks.mjs", "test/support/scm-to-untouched-lines-loader.mjs",
  "tools/scm-to-untouched-lines-live.mjs", "tools/scm-to-untouched-lines-test.sh", "test/scm-to-untouched-lines-spec.md"]);

const coverage = JSON.parse(await readFile(`${artifact}/coverage/coverage-final.json`, "utf8"));
const fileCoverage = Object.values(coverage).find(entry => entry.path.endsWith(`/${sourceFile}`));
assert.ok(fileCoverage);
// Unified patch records final-to-baseline edits. Removed lines are changed final lines.
const patch = await readFile("test/support/scm-to-untouched-lines-baseline.patch", "utf8");
let finalLine = 0;
const changed = [];
for (const line of patch.split("\n")) {
  const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+/u);
  if (hunk) {finalLine = Number(hunk[1]);}
  else if (line.startsWith("---") || line.startsWith("+++")) {continue;}
  else if (line.startsWith("-")) {changed.push(finalLine++);}
  else if (line.startsWith(" ")) {finalLine += 1;}
}
const executable = changed.filter(line => Object.values(fileCoverage.statementMap).some(loc => loc.start.line <= line && loc.end.line >= line));
const missing = executable.filter(line => !Object.entries(fileCoverage.statementMap).some(([id, loc]) =>
  loc.start.line <= line && loc.end.line >= line && fileCoverage.s[id] > 0));
assert.ok(executable.length > 0);
assert.deepEqual(missing, [], `Uncovered changed lines: ${missing.join(",")}`);
assert.equal(createHash("sha256").update(await readFile(sourceFile)).digest("hex"), sourceSha256);
const summary = { sourceSha256, tests: Number(focused.output.match(/^# tests (\d+)$/mu)?.[1]),
  mutationKills: kills, propertyKills, propertySurvivors,
  changedLineCoverage: { executed: executable.length, total: executable.length, missing } };
await writeFile(`${artifact}/checks.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
