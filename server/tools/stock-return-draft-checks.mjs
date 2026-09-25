import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanTextForSecrets } from "../test/support/scan-diff-secrets.mjs";

const root = process.cwd();
const artifact = path.resolve("test-artifacts/stock-return-insert");
const sourceFile = "src/return-repository.js";
const testFile = "test/mbt/integration/stock-return-draft-insert.test.js";
const source = readFileSync(sourceFile, "utf8");
const baseline = readFileSync(`${artifact}/baseline/${sourceFile}`, "utf8");
const expression = "$23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33::jsonb, $34::jsonb";

function run(name, args, { cwd = root, accepted = [0] } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 40e6, timeout: 120000 });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  writeFileSync(`${artifact}/${name}.log`, output);
  assert.ok(accepted.includes(result.status), `${name}: exit ${result.status}; see ${artifact}/${name}.log`);
  console.log(`${name}: exit ${result.status}`);
  return output;
}

function clone() {
  const directory = mkdtempSync(path.join(tmpdir(), "stock-return-check-"));
  cpSync("src", `${directory}/src`, { recursive: true });
  cpSync("package.json", `${directory}/package.json`);
  mkdirSync(path.dirname(`${directory}/${testFile}`), { recursive: true });
  cpSync(testFile, `${directory}/${testFile}`);
  symlinkSync(path.join(root, "node_modules"), `${directory}/node_modules`, "dir");
  return directory;
}

function staticChecks() {
  run("syntax", ["--check", sourceFile]);
  run("lint-new", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js", "--max-warnings=0",
    testFile, "tools/stock-return-draft-checks.mjs"]);
  const directory = clone();
  try {
    writeFileSync(`${directory}/${sourceFile}`, baseline);
    const lintArgs = [path.resolve("node_modules/eslint/bin/eslint.js"), "--config", path.resolve("tools/return-ra-eslint.config.mjs"),
      "--format=json", sourceFile];
    const lintBefore = JSON.parse(run("lint-baseline", lintArgs, { cwd: directory, accepted: [0, 1] }));
    const lintAfter = JSON.parse(run("lint-release", lintArgs, { accepted: [0, 1] }));
    const diagnostics = results => results.map(result => result.messages.map(message => ({
      ruleId: message.ruleId, severity: message.severity, message: message.message,
      line: message.line, column: message.column, endLine: message.endLine, endColumn: message.endColumn
    })));
    assert.deepEqual(diagnostics(lintAfter), diagnostics(lintBefore));
    const args = [path.resolve("node_modules/typescript/bin/tsc"), "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck",
      "--target", "es2023", "--module", "nodenext", sourceFile];
    const before = run("types-baseline", args, { cwd: directory, accepted: [0, 1, 2] });
    const after = run("types-release", args, { accepted: [0, 1, 2] });
    assert.equal(after, before, "No new type diagnostics are allowed");
    assert.deepEqual(scanTextForSecrets(readFileSync(`${artifact}/release.patch`, "utf8"), "release.patch"), []);
    return { lintBaseline: lintBefore.reduce((total, result) => total + result.messages.length, 0),
      typeBaseline: (before.match(/error TS/g) || []).length };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function mutations() {
  const faults = [
    ["extra-expression", expression, expression.replace("$33::jsonb, $34::jsonb", "$33, $34::jsonb, $35::jsonb"), "generated fractional"],
    ["rate-estimate-swap", "$30, $31, $32, $33::jsonb", "$30, $32, $31, $33::jsonb", "generated fractional"],
    ["snapshot-swap", "$33::jsonb, $34::jsonb", "$34::jsonb, $33::jsonb", "generated fractional"],
    ["draft-retained", '"DELETE FROM return_drafts WHERE id = $1::uuid AND operator_id = $2"',
      '"SELECT id FROM return_drafts WHERE id = $1::uuid AND operator_id = $2"', "normal stock draft"],
    ["premature-draft-removal", "draftState = draftResult.rows[0];",
      'draftState = draftResult.rows[0]; await query("DELETE FROM return_drafts WHERE id=$1::uuid", [draftId]);', "invalid and excess"]
  ];
  const results = [];
  for (const [name, original, replacement, testPattern, file = sourceFile] of faults) {
    const directory = clone();
    try {
      let input = readFileSync(`${directory}/${file}`, "utf8");
      assert.ok(input.includes(original), `Mutation location missing: ${name}`);
      input = input.replace(original, replacement);
      writeFileSync(`${directory}/${file}`, input);
      const output = run(`mutant-${name}`, ["--test", `--test-name-pattern=${testPattern}`, testFile], { cwd: directory, accepted: [1] });
      assert.match(output, /not ok/);
      results.push({ name, killed: true, generatedPropertyOnly: testPattern === "generated fractional" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  writeFileSync(`${artifact}/mutations.json`, JSON.stringify(results, null, 2) + "\n");
  return results;
}

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.ok(source.includes(expression));
const staticResult = staticChecks();
run("release-coverage-tests", ["node_modules/c8/bin/c8.js", "--all=false", "--include=src/return-repository.js",
  "--check-coverage=false", "--reporter=json", "--reporter=text", `--report-dir=${artifact}/coverage`,
  "--temp-directory=/tmp/stock-return-insert-c8", process.execPath, "--test", testFile]);
const coverage = JSON.parse(readFileSync(`${artifact}/coverage/coverage-final.json`, "utf8"));
const fileCoverage = coverage[path.resolve(sourceFile)];
const changedLine = source.split("\n").findIndex(line => line.includes(expression)) + 1;
const covering = Object.entries(fileCoverage.statementMap).filter(([, range]) =>
  range.start.line <= changedLine && range.end.line >= changedLine);
assert.ok(covering.some(([id]) => fileCoverage.s[id] > 0), "Changed SQL line must execute");
run("release-return-harness", ["src/return-module-harness.js"]);
const mutationResult = mutations();
run("final-release-tests", ["--test", testFile]);
const verified = { sourceHash: createHash("sha256").update(source).digest("hex"), node: process.version,
  tests: 5, generatedCases: 24, changedLinesCovered: 1, changedLines: 1, mutantsKilled: mutationResult.length,
  ...staticResult };
writeFileSync(`${artifact}/verified.json`, JSON.stringify(verified, null, 2) + "\n");
console.log(JSON.stringify(verified));
