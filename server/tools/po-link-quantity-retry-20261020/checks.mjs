import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";
import istanbulCoverage from "istanbul-lib-coverage";

const core = "test/dispatch/integration/po-link-quantity-retry.test.js";
const file = "src/dispatch-repository.js";
const baseline = "/workspace/server/deployments/po-link-quantity-retry-20261020/before";
const original = readFileSync(file, "utf8");
const sha = text => createHash("sha256").update(text).digest("hex");
const save = (name, data) => writeFileSync(`test-artifacts/${name}.json`, JSON.stringify(data, null, 2));
const regressions = [
  "test/dispatch/integration/dispatch-link-base.test.js",
  "test/dispatch/integration/dispatch-target-line-identity.test.js",
  "test/dispatch/integration/dispatch-po-split-link-target.test.js",
  "test/dispatch/integration/dispatch-po-count.test.js",
  "test/dispatch/frontend/scm-dependency-atomic-ui.red.test.js",
  "test/dispatch/frontend/dispatch-save-reliability.test.js",
  "test/dispatch/frontend/dispatch-link-base.browser.test.mjs",
  "test/dispatch/frontend/dispatch-po-ref-link-search.test.js"
];

function run(args, label, options = {}) {
  const result = spawnSync("node", args, { encoding: "utf8", timeout: 120000, maxBuffer: 24 * 1024 * 1024, ...options });
  writeFileSync(`test-artifacts/${label}.log`, (result.stdout || "") + (result.stderr || ""));
  assert.ok(result.status !== null, `${label}: ${result.error || result.signal}`);
  return result;
}

async function isolated(testFile, label, { cwd = "/app", pattern, coverage = false } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const url = new URL(process.env.DATABASE_URL);
  const template = url.pathname.slice(1);
  assert.match(template, /^[a-zA-Z0-9_]+$/u);
  const database = `quantity_retry_${randomUUID().replaceAll("-", "")}`;
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const db = new pg.Client({ connectionString: admin.href });
  await db.connect();
  try {
    await db.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
    url.pathname = `/${database}`;
    const args = ["--test", "--test-concurrency=1", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), testFile];
    if (coverage) {
      args.unshift("node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
        `--include=${file}`, "--reporter=json", "--report-dir=/app/test-artifacts/coverage",
        "--temp-directory=/tmp/quantity-retry-c8", "node");
    }
    const result = run(args, label, { cwd, env: { ...process.env, DATABASE_URL: url.href } });
    const row = {
      label, file: testFile, exit: result.status,
      failures: [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]),
      ...Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gmu)]
        .map(match => [match[1], Number(match[2])]))
    };
    console.log(JSON.stringify(row));
    return row;
  } finally {
    await db.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await db.end();
  }
}

const results = [];
for (const testFile of regressions) {
  const result = await isolated(testFile, `regression-${results.length}`);
  results.push(result);
}
save("regressions", results);
const baselineFailures = [];
for (const result of results.filter(row => row.exit !== 0)) {
  const root = mkdtempSync("/tmp/quantity-retry-baseline-");
  try {
    for (const dir of ["src", "public"]) cpSync(`${baseline}/${dir}`, `${root}/${dir}`, { recursive: true });
    cpSync(`${baseline}/package.json`, `${root}/package.json`);
    cpSync("test", `${root}/test`, { recursive: true });
    symlinkSync("/app/node_modules", `${root}/node_modules`);
    const previous = await isolated(result.file, `${result.label}-baseline`, { cwd: root });
    assert.equal(result.exit, previous.exit);
    assert.deepEqual(result.failures, previous.failures, "New regression against the deployed baseline.");
    assert.equal(result.pass, previous.pass);
    baselineFailures.push(previous);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
save("baseline-failures", baselineFailures);

assert.equal(run(["--check", file], "syntax").status, 0);
const lintArgs = ["node_modules/eslint/bin/eslint.js", "--config", "tools/dispatch-link-base-eslint.config.mjs",
  "--stdin", "--stdin-filename", file, "--format", "json"];
const diagnostics = [];
for (const [mode, source] of [["before", readFileSync(`${baseline}/${file}`, "utf8")], ["after", original]]) {
  const result = run(lintArgs, `lint-${mode}`, { input: source });
  assert.ok([0, 1].includes(result.status), result.stderr);
  diagnostics.push(JSON.parse(result.stdout).flatMap(row => row.messages.map(message =>
    JSON.stringify({ rule: message.ruleId, message: message.message }))));
}
const remaining = [...diagnostics[0]];
for (const message of diagnostics[1]) {
  const index = remaining.indexOf(message);
  assert.ok(index >= 0, `New lint diagnostic: ${message}`);
  remaining.splice(index, 1);
}
const testLint = run(["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js",
  "--max-warnings=0", core], "test-lint");
assert.equal(testLint.status, 0, testLint.stdout);
save("static", {
  baselineLintDiagnostics: diagnostics[0].length, currentLintDiagnostics: diagnostics[1].length,
  addedTestLintErrors: 0, syntaxPassed: true,
  types: "This runtime file has no checked type annotations and is outside tsconfig.mbt.json; no type-safety claim.",
  node: process.version,
  versions: Object.fromEntries(["eslint", "c8", "fast-check", "pg", "@playwright/test"].map(name =>
    [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version]))
});

const root = mkdtempSync("/tmp/quantity-retry-mutants-");
const mutants = [
  ["so-physical-500", "value > salesAvailable"],
  ["po-physical-500", "value > poAvailable"],
  ["so-base-500", "salesQty > salesRemaining + 0.000001"],
  ["po-base-500", "salesQty > poRemaining + 0.000001"]
];
const mutationResults = [];
try {
  for (const dir of ["src", "public"]) cpSync(dir, `${root}/${dir}`, { recursive: true });
  cpSync("package.json", `${root}/package.json`);
  symlinkSync("/app/node_modules", `${root}/node_modules`);
  mkdirSync(`${root}/test/dispatch/integration`, { recursive: true });
  mkdirSync(`${root}/test/dispatch/support`, { recursive: true });
  cpSync(core, `${root}/${core}`);
  cpSync("test/dispatch/support/dispatch-v2-fixture.js", `${root}/test/dispatch/support/dispatch-v2-fixture.js`);
  for (const [name, guard] of [...mutants, ["omit-po-limit", "salesQty > poRemaining + 0.000001"]]) {
    const anchor = `if (${guard}) throw Object.assign(`;
    assert.equal(original.split(anchor).length, 2);
    let mutant;
    if (name === "omit-po-limit") {
      mutant = original.replace(anchor, "if (false) throw Object.assign(");
    } else {
      const start = original.indexOf(anchor);
      const status = original.indexOf("status: 400", start);
      assert.ok(status - start < 300);
      mutant = original.slice(0, status) + original.slice(status).replace("status: 400", "status: 500");
    }
    writeFileSync(`${root}/${file}`, mutant);
    for (const propertyOnly of [false, true]) {
      const label = `${name}${propertyOnly ? "-properties" : ""}`;
      const result = await isolated(core, label, {
        cwd: root, ...(propertyOnly ? { pattern: "capacity properties" } : {})
      });
      assert.equal(result.exit, 1, `${label} survived`);
      assert.ok(result.failures.length && result.failures.every(name => !name.endsWith(".test.js")),
        `${label} must fail behavior assertions`);
      mutationResults.push(result);
    }
  }
  // Prove the pre-existing uncertainty tests fail if an edited retry replaces
  // a potentially committed request. This client code is not part of the fix.
  writeFileSync(`${root}/${file}`, original);
  const clientFile = `${root}/public/dispatch.js`;
  const clientSource = readFileSync(clientFile, "utf8");
  const retryAnchor = 'const retry = pendingDispatchPlanAction?.kind === "dependency" ? pendingDispatchPlanAction : null;';
  assert.equal(clientSource.split(retryAnchor).length, 2);
  writeFileSync(clientFile, clientSource.replace(retryAnchor, "pendingDispatchPlanAction = null;\n  const retry = null;"));
  const retryMutant = await isolated(core, "discard-uncertain-retry", {
    cwd: root, pattern: "retains the original quantity"
  });
  assert.equal(retryMutant.exit, 1);
  assert.deepEqual(retryMutant.failures, [
    "HTTP 500 retains the original quantity and request identity on retry",
    "lost response retains the original quantity and request identity on retry"
  ]);
  mutationResults.push(retryMutant);
} finally {
  rmSync(root, { recursive: true, force: true });
  assert.equal(readFileSync(file, "utf8"), original);
}
save("mutations", mutationResults);

rmSync("test-artifacts/coverage", { recursive: true, force: true });
rmSync("/tmp/quantity-retry-c8", { recursive: true, force: true });
const finalCore = await isolated(core, "final-core", { coverage: true });
assert.equal(finalCore.exit, 0);
const changed = JSON.parse(readFileSync("test-artifacts/changed-lines.json", "utf8"));
const map = istanbulCoverage.createCoverageMap(JSON.parse(readFileSync("test-artifacts/coverage/coverage-final.json", "utf8")));
const hits = map.fileCoverageFor(`/app/${file}`).getLineCoverage();
const executable = changed.filter(line => Object.hasOwn(hits, line));
const missing = executable.filter(line => hits[line] <= 0);
assert.ok(executable.length > 0);
assert.deepEqual(missing, []);
save("coverage-changed", { file, changedLines: changed, executable, covered: executable.length, missing });

// Reorder the suites most sensitive to request/retry state.
const reordered = [];
for (const testFile of [regressions[5], core, regressions[0]].reverse()) {
  const result = await isolated(testFile, `reordered-${reordered.length}`);
  assert.equal(result.exit, 0);
  reordered.push(result);
}
save("reordered", reordered);
const summary = {
  passed: true, sourceHash: sha(original),
  regressionTests: results.reduce((sum, row) => sum + row.pass, 0),
  unchangedBaselineFailures: baselineFailures.reduce((sum, row) => sum + row.fail, 0),
  coreTests: finalCore.pass, propertyExamples: 24,
  mutantsKilled: 6, propertyMutantsKilled: 5,
  changedExecutableLines: executable.length, coveredChangedLines: executable.length,
  reorderedTests: reordered.reduce((sum, row) => sum + row.pass, 0)
};
save("summary", summary);
console.log(JSON.stringify(summary));
