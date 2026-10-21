import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tests as existingLinkTests } from "../link-to-fix-files.mjs";

const mode = process.argv[2] || "final";
const out = "test-artifacts";
mkdirSync(out, { recursive: true });
function run(label, args) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 240000
  });
  const log = result.stdout + result.stderr;
  writeFileSync(`${out}/${mode}-${label}.log`, log);
  return { status: result.status, log };
}
function tests(label, args) {
  const result = run(label, args);
  assert.notEqual(result.status, null, `suite must finish: ${label}`);
  const failures = [...result.log.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]).sort();
  const count = key => Number([...result.log.matchAll(new RegExp("^# " + key + " (\\d+)$", "gm"))].at(-1)?.[1] || 0);
  assert.ok(count("tests") > 0, `tests must execute: ${label}`);
  return { exit: result.status, tests: count("tests"), pass: count("pass"), fail: count("fail"), failures };
}
const adjacent = [...new Set([
  ...existingLinkTests,
  "test/mbt/integration/link-to-group.test.js",
  "test/dispatch/integration/to-dependency-packing-independent.test.js",
  "test/dispatch/integration/dispatch-planner-compact-command.red.test.js",
  "test/dispatch/integration/scm-dependency-target-search.red.test.js",
  "test/mbt/unit/driver-yard-dependency-mode.test.js",
  "test/mbt/unit/scm-dependency-command-service.red.test.js",
  "test/mbt/unit/scm-dependency-management-policy.red.test.js",
  "test/mbt/unit/scm-dependency-plan-reconciler.red.test.js",
  "test/dispatch/frontend/scm-dependency-atomic-ui.red.test.js",
  "test/scm-transfer-dependency-workflow.test.js"
])].sort();
// A deterministic different order exercises suite independence in the final run.
if (mode === "final") {
  adjacent.sort((left, right) => createHash("sha256").update(left).digest("hex")
    .localeCompare(createHash("sha256").update(right).digest("hex")));
}
const summary = { mode, adjacent: tests("adjacent", ["--test", "--test-concurrency=1", ...adjacent]) };
const lint = run("lint", ["node_modules/eslint/bin/eslint.js", "--config", "tools/retired-group-dependency-20261006/eslint.config.mjs",
  "--format", "json", "src/order-dependency-repository.js", "test/mbt/integration/retired-group-dependency.test.js",
  "tools/retired-group-dependency-20261006/eslint.config.mjs", "tools/retired-group-dependency-20261006/gauntlet.mjs",
  "tools/retired-group-dependency-20261006/mutations.mjs", "tools/retired-group-dependency-20261006/live.mjs"]);
summary.lint = JSON.parse(lint.log).flatMap(file => file.messages.map(message => ({
  file: file.filePath.replace("/app/", ""), rule: message.ruleId, message: message.message
})));
const types = run("types", ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit"]);
summary.types = types.log.split("\n").filter(line => /error TS\d+/u.test(line))
  .map(line => line.replace(/\(\d+,\d+\)/u, ""));
summary.typeExit = types.status;
for (const name of ["src/order-dependency-repository.js", "test/mbt/integration/retired-group-dependency.test.js",
  "tools/retired-group-dependency-20261006/gauntlet.mjs", "tools/retired-group-dependency-20261006/mutations.mjs"]) {
  assert.equal(run(name.replaceAll("/", "-"), ["--check", name]).status, 0);
}
if (mode === "final") {
  const baseline = JSON.parse(readFileSync(`${out}/baseline-summary.json`, "utf8"));
  summary.newFailures = summary.adjacent.failures.filter(name => !baseline.adjacent.failures.includes(name));
  assert.deepEqual(summary.newFailures, []);
  function newDiagnostics(previous, current) {
    // ESLint includes an enclosing declaration's location in no-shadow
    // messages; inserted lines move that location without changing the issue.
    const key = value => JSON.stringify(value).replace(/on line \d+ column \d+/gu, "at an enclosing declaration");
    const remaining = previous.map(key);
    return current.filter(value => {
      const index = remaining.indexOf(key(value));
      if (index < 0) { return true; }
      remaining.splice(index, 1);
      return false;
    });
  }
  assert.deepEqual(newDiagnostics(baseline.lint, summary.lint), [], "zero new lint diagnostics");
  assert.deepEqual(newDiagnostics(baseline.types, summary.types), [], "zero new type diagnostics");
  rmSync(`${out}/coverage`, { recursive: true, force: true });
  summary.focused = tests("focused", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
    "--include=src/order-dependency-repository.js", "--temp-directory=/tmp/retired-group-c8",
    `--report-dir=${out}/coverage`, "--reporter=json", "--reporter=json-summary", "--reporter=text",
    "node", "--test", "--test-concurrency=1", "test/mbt/integration/retired-group-dependency.test.js"]);
  assert.equal(summary.focused.fail, 0);
  assert.equal(run("mutations", ["tools/retired-group-dependency-20261006/mutations.mjs"]).status, 0);
  summary.mutations = JSON.parse(readFileSync(`${out}/mutations.json`, "utf8"));
  summary.sourceHash = createHash("sha256").update(readFileSync("src/order-dependency-repository.js")).digest("hex");
  const changed = JSON.parse(readFileSync("/workspace/server/test-artifacts/retired-group-dependency-20261006/changed-lines.json", "utf8"));
  const coverage = Object.values(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`, "utf8")))[0];
  const executed = new Set(Object.entries(coverage.statementMap).filter(([id]) => coverage.s[id] > 0)
    .flatMap(([, location]) => Array.from({ length: location.end.line - location.start.line + 1 }, (_, index) => location.start.line + index)));
  summary.changedLines = { total: changed.length, covered: changed.filter(line => executed.has(line)).length,
    uncovered: changed.filter(line => !executed.has(line)) };
  writeFileSync(`${out}/changed-line-coverage.json`, JSON.stringify(summary.changedLines, null, 2) + "\n");
  assert.deepEqual(summary.changedLines.uncovered, [], "all changed lines must execute");
  summary.versions = { node: process.version };
  for (const name of ["c8", "typescript", "eslint", "pg", "fast-check"]) {
    summary.versions[name] = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
  }
}
writeFileSync(`${out}/${mode}-summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ mode, adjacent: summary.adjacent, focused: summary.focused,
  lintDiagnostics: summary.lint.length, typeDiagnostics: summary.types.length, mutations: summary.mutations }));
