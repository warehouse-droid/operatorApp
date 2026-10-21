import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const mode = process.argv[2] || "final";
const out = `/app/split-if-evidence/${mode}`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sourceFile = "src/sales-order-auto-fulfillment-repository.js";
const regression = "test/mbt/integration/split-fulfillment-evidence.test.js";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const suiteFiles = [...new Set([
  ...pkg.scripts["test:operator-linked-fulfillment"].split(" ").filter(value => value.endsWith(".js")),
  ...pkg.scripts["test:operator-netsuite-posting-gates"].split(" ").filter(value => value.endsWith(".js")),
  "test/mbt/unit/netsuite-attention-first-split.test.js"
])];
const results = [];
function run(label, executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 300000, maxBuffer: 20 * 1024 * 1024, ...options });
  const output = (result.stdout || "") + (result.stderr || "");
  writeFileSync(`${out}/${label}.log`, output);
  const summary = { label, exit: result.status,
    tests: Number(output.match(/^# tests (\d+)$/m)?.[1] || 0),
    passed: Number(output.match(/^# pass (\d+)$/m)?.[1] || 0),
    failed: Number(output.match(/^# fail (\d+)$/m)?.[1] || 0) };
  results.push(summary);
  console.log(JSON.stringify(summary));
  return { ...summary, output };
}
const regressionResult = run("regression", "node", ["--test", "--test-concurrency=1", regression]);
if (mode === "red") {
  assert.ok(regressionResult.failed >= 5);
  process.exit(0);
}
run("subsystem", "node", ["--test", "--test-concurrency=1", ...suiteFiles]);
run("syntax", "node", ["--check", sourceFile]);
run("lint", "node", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js",
  "--max-warnings=0", sourceFile, regression]);
run("types", "node", ["node_modules/typescript/bin/tsc", "--noEmit", "--allowJs", "--checkJs", "false",
  "--skipLibCheck", "--strict", "--noUncheckedIndexedAccess", "--module", "NodeNext",
  "--moduleResolution", "NodeNext", "--target", "ES2023", sourceFile]);

if (mode === "final") {
  run("coverage", "node", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
    `--include=${sourceFile}`, `--temp-directory=${out}/coverage-tmp`, `--report-dir=${out}/coverage`,
    "--reporter=json", "--reporter=json-summary", "--reporter=text",
    "node", "--test", "--test-concurrency=1", regression]);
  const coverage = JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`, "utf8"));
  const coveredFile = coverage[`/app/${sourceFile}`];
  const changedLines = readFileSync(sourceFile, "utf8").split("\n").flatMap((line, index) =>
    /const lineIds = lines\.map\(\(line\) => Number\(line\.local_line_id\)\);|const (poRows|toRows) = (poEvidence|toEvidence)\.get\(text\(line\.local_line_id\)\)/.test(line)
      ? [index + 1] : []);
  assert.equal(changedLines.length, 4);
  const changedCoverage = changedLines.map(line => ({ line, covered: Object.entries(coveredFile.statementMap)
    .some(([id, location]) => location.start.line <= line && location.end.line >= line && coveredFile.s[id] > 0) }));
  assert.ok(changedCoverage.every(line => line.covered));
  writeFileSync(`${out}/changed-lines.json`, JSON.stringify(changedCoverage, null, 2) + "\n");
  run("reversed-order", "node", ["--test", "--test-concurrency=1", ...[...suiteFiles].reverse(), regression]);
  const scratch = "/tmp/split-if-mutation";
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  cpSync("src", `${scratch}/src`, { recursive: true });
  cpSync("package.json", `${scratch}/package.json`);
  mkdirSync(`${scratch}/test/mbt/integration`, { recursive: true });
  cpSync(regression, `${scratch}/${regression}`);
  symlinkSync("/app/node_modules", `${scratch}/node_modules`);
  for (const directory of ["public", "contracts", "migrations"]) symlinkSync(`/app/${directory}`, `${scratch}/${directory}`);
  const original = readFileSync(sourceFile, "utf8");
  const domainFile = "src/sales-order-auto-fulfillment-domain.js";
  const originalDomain = readFileSync(domainFile, "utf8");
  const mutations = [
    ["po-source-query", sourceFile, original,
      "async function poExecutionEvidence(source, lines) {\n  const lineIds = lines.map((line) => Number(line.local_line_id));",
      "async function poExecutionEvidence(source, lines) {\n  const lineIds = lines.map((line) => Number(line.source_line_id));"],
    ["to-source-query", sourceFile, original,
      "async function directToExecutionEvidence(source, lines) {\n  const lineIds = lines.map((line) => Number(line.local_line_id));",
      "async function directToExecutionEvidence(source, lines) {\n  const lineIds = lines.map((line) => Number(line.source_line_id));"],
    ["po-source-lookup", sourceFile, original,
      "poEvidence.get(text(line.local_line_id))", "poEvidence.get(text(line.source_line_id))"],
    ["to-source-lookup", sourceFile, original,
      "toEvidence.get(text(line.local_line_id))", "toEvidence.get(text(line.source_line_id))"],
    ["disable-quantity-conservation", domainFile, originalDomain,
      "if (Math.abs(deliveredQuantity - targetQuantity) > EPSILON) {", "if (false) {"]
  ];
  for (const [name, file, source, find, replace] of mutations) {
    assert.equal(source.split(find).length, 2, `unique mutation anchor: ${name}`);
    try {
      writeFileSync(`${scratch}/${file}`, source.replace(find, replace));
      const result = run(`mutant-${name}`, "node", ["--test", "--test-concurrency=1", regression], { cwd: scratch });
      assert.equal(result.tests, 13, `mutation test suite did not execute: ${name}`);
      const behavioralFailure = /ERR_ASSERTION/.test(result.output)
        || (name === "disable-quantity-conservation" && /code: '25P02'/.test(result.output));
      assert.ok(behavioralFailure && !/ERR_MODULE_NOT_FOUND/.test(result.output),
        `mutation must fail executed behavior, not test setup: ${name}`);
      assert.ok(result.failed > 0, `mutation survived: ${name}`);
    } finally {
      writeFileSync(`${scratch}/${file}`, source);
    }
  }
  assert.equal(readFileSync(`${scratch}/${sourceFile}`, "utf8"), original);
}
const versions = Object.fromEntries(["c8", "eslint", "typescript", "fast-check", "pg"].map(name =>
  [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version]));
writeFileSync(`${out}/result.json`, JSON.stringify({
  mode, sourceHash: createHash("sha256").update(readFileSync(sourceFile)).digest("hex"),
  node: process.version, versions, results,
  failures: results.filter(result => result.exit !== 0 && !result.label.startsWith("mutant-"))
}, null, 2) + "\n");
if (mode === "final") assert.equal(regressionResult.exit, 0);
