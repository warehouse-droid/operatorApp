import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const out = "test-artifacts/driver-reopen-replan-final";
mkdirSync(out, { recursive: true });
function failedBehaviors(output) {
  return [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]);
}
function run(name, args, baseline = "") {
  const result = spawnSync("node", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(`${out}/${name}.log`, result.stdout + result.stderr);
  if (baseline && result.status !== 0) {
    const previous = readFileSync(baseline, "utf8");
    assert.deepEqual(failedBehaviors(result.stdout), failedBehaviors(previous), "new adjacent test failures");
    const legacyError = "The input did not match the regular expression /dispatch\\.js\\?v=20260927-readonly-loads-v3/u.";
    assert.ok(previous.includes(legacyError) && result.stdout.includes(legacyError));
  } else {
    assert.equal(result.status, 0, `${name} failed; see ${out}/${name}.log`);
  }
  const counts = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gmu)].map(match => [match[1], Number(match[2])]));
  console.log(JSON.stringify({ check: name, noNewFailures: true, ...counts }));
  return counts;
}
const core = run("core-coverage", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false", "--include=src/driver-pwa-repository.js", "--include=src/server.js", "--temp-directory=/tmp/driver-reopen-c8", `--report-dir=${out}/coverage`, "--reporter=text", "--reporter=json", "--reporter=json-summary", "node", "--test", "--test-concurrency=1", "test/mbt/integration/driver-reopen-replan.test.js"]);
const adjacent = run("adjacent", ["--test", "--test-concurrency=1",
  "test/mbt/integration/dispatch-completion-status.red.test.js",
  "test/mbt/integration/dispatch-completion-http.red.test.js",
  "test/mbt/concurrency/dispatch-completion-races.test.js",
  "test/mbt/integration/driver-retained-completion-photos.test.js",
  "test/mbt/integration/driver-pwa-historical-assist-migration.test.js",
  "test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js",
  "test/dispatch/frontend/dispatch-completion-ui.test.js",
  "test/mbt/adversarial/dispatch-completion-repository-adversarial.test.js"
], "/workspace/server/test-artifacts/driver-reopen-replan-20261006/baseline-adjacent-full.log");
run("pwa-harness", ["src/driver-pwa-stop-harness.js"]);
run("static", ["tools/driver-reopen-replan-static.mjs", "current"]);
for (const name of ["lint", "type"]) {
  const previous = JSON.parse(readFileSync(`test-artifacts/driver-reopen-replan-baseline-static/${name}-messages.json`, "utf8"));
  const current = JSON.parse(readFileSync(`test-artifacts/driver-reopen-replan-current-static/${name}-messages.json`, "utf8"));
  const counts = new Map();
  for (const message of previous) { const key = JSON.stringify(message); counts.set(key, (counts.get(key) || 0) + 1); }
  for (const message of current) {
    const key = JSON.stringify(message);
    assert.ok(counts.get(key) > 0, `New ${name} diagnostic: ${key}`);
    counts.set(key, counts.get(key) - 1);
  }
  console.log(JSON.stringify({ check: `${name}-baseline-comparison`, baseline: previous.length, current: current.length, newDiagnostics: 0 }));
}
const changed = JSON.parse(readFileSync("/workspace/server/test-artifacts/driver-reopen-replan-20261006/changed-lines.json", "utf8"));
const coverage = JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`, "utf8"));
let changedCount = 0;
for (const [name, lines] of Object.entries(changed)) {
  const file = coverage[`/app/${name}`];
  assert.ok(file, `No coverage for ${name}`);
  for (const line of lines) {
    const statements = Object.entries(file.statementMap).filter(([_key, range]) => range.start.line <= line && range.end.line >= line);
    assert.ok(statements.some(([key]) => file.s[key] > 0), `Changed line not executed: ${name}:${line}`);
    changedCount += 1;
  }
}
run("legacy-migration", ["--test", "test/mbt/integration/dispatch-completion-migration.test.js"]);
run("mutations", ["tools/driver-reopen-replan-mutations.mjs"]);
const mutants = JSON.parse(readFileSync("test-artifacts/driver-reopen-replan-mutations/result.json", "utf8"));
const result = { passed: true, core, adjacent, preexistingAdjacentFailures: adjacent.fail, changedLinesExecuted: changedCount, changedLinesTotal: changedCount, mutantsKilled: mutants.length, mutantsTotal: mutants.length, newTypeDiagnostics: 0, newLintDiagnostics: 0 };
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
