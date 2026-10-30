import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Run only through the disposable Docker runner");
const artifact = "/app/test-artifacts/regroup";
await mkdir(artifact, { recursive: true });
const focused = ["test/dispatch/integration/dispatch-cross-plan-regroup.test.js",
  "test/dispatch/integration/dispatch-cross-plan-regroup-http.test.js"];
const regressions = ["test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js",
  "test/dispatch/concurrency/dispatch-derived-order-retirement-concurrency.red.test.js",
  "test/dispatch/frontend/dispatch-authoritative-retirement.red.test.js"];
const sourceFile = "src/dispatch-delivery-group-repository.js";
const source = await readFile(sourceFile, "utf8");
const nodeTest = ["--test", "--test-concurrency=1"];
const register = ["--import", "./test/support/dispatch-regroup-mutation-register.mjs"];

async function run(name, args, env = {}) {
  const child = spawnSync(process.execPath, args, {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024
  });
  const output = `${child.stdout || ""}\n${child.stderr || ""}`;
  await writeFile(path.join(artifact, `${name}.log`), output);
  assert.ifError(child.error);
  const result = { name, status: child.status,
    passed: Number(output.match(/^# pass (\d+)$/m)?.[1] || 0),
    failed: Number(output.match(/^# fail (\d+)$/m)?.[1] || 0),
    failures: [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort() };
  console.log(JSON.stringify(result));
  if (child.status && (!result.failed || name === "focused" || name === "reordered")) { console.log(output.slice(-6000)); }
  return result;
}

const focusedResult = await run("focused", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
  `--include=${sourceFile}`, `--temp-directory=${artifact}/c8`, `--report-dir=${artifact}/coverage`,
  "--reporter=json", "--reporter=text", "node", ...nodeTest, ...focused]);
assert.equal(focusedResult.status, 0);
const baseline = await run("baseline-regressions", [...register, ...nodeTest, ...regressions], { MBBS_REGROUP_MUTATION: "baseline" });
assert.deepEqual(baseline.failures, [
  "SO, PO, TO, and CO splits are global definitions while their date assignment remains independent",
  "grouped CO and CO-of-group are global without hiding the source-order lifecycle"
]);
const candidate = await run("candidate-regressions", [...nodeTest, ...regressions]);
assert.deepEqual(candidate.failures, baseline.failures, "No new lifecycle regression failures");
assert.equal(candidate.passed, baseline.passed);
const mutations = [];
for (const mutation of ["baseline", "active_owner_overwrite", "stale_assigned_restore"]) {
  for (const propertyOnly of [false, true]) {
    const result = await run(`mutation-${mutation}-${propertyOnly ? "property" : "all"}`,
      [...register, ...nodeTest, ...(propertyOnly ? ["--test-name-pattern=property:"] : []), focused[0]],
      { MBBS_REGROUP_MUTATION: mutation });
    assert.ok(result.failed > 0, `Tests must kill ${mutation}`);
    mutations.push({ mutation, propertyOnly, killed: true });
  }
}
const reordered = await run("reordered", [...nodeTest, ...[...focused].reverse()]);
assert.equal(reordered.status, 0);
const lint = await run("lint", ["node_modules/eslint/bin/eslint.js", "--config",
  "test/support/retired-confirm-eslint.config.mjs", "--max-warnings=0", sourceFile, ...focused,
  "test/support/dispatch-regroup-mutation-loader.mjs", "test/support/dispatch-regroup-mutation-register.mjs",
  "test/support/run-dispatch-regroup-checks.mjs"]);
assert.equal(lint.status, 0);
const syntax = await run("syntax", ["--check", sourceFile]);
assert.equal(syntax.status, 0);
const secrets = await run("secrets", ["test/support/scan-diff-secrets.mjs", sourceFile, ...focused,
  "test/support/dispatch-regroup-mutation-loader.mjs", "test/support/dispatch-regroup-mutation-register.mjs",
  "test/support/run-dispatch-regroup-checks.mjs"]);
assert.equal(secrets.status, 0);
const coverage = JSON.parse(await readFile(`${artifact}/coverage/coverage-final.json`, "utf8"));
const entry = Object.entries(coverage).find(([file]) => file.endsWith(`/${sourceFile}`))?.[1];
assert.ok(entry, "Coverage must include the changed repository");
const probes = ["async function syncDispatchGlobalOrderGroupsFromPlan(plan = {}, allowedReactivations",
  "`SELECT lower(group_ref) AS group_key, source_plan_id, active,", "active: row.active,",
  "const reactivating = existingSource?.active === false", "&& allowedReactivations.has(group.groupRef.toLowerCase())",
  "&& !reactivating) return [];", "syncDispatchGlobalOrderGroupsFromPlan(effectivePlan, allowedReactivations)"];
const groupStart = source.indexOf("async function syncDispatchGlobalOrderGroupsFromPlan");
const coveredLines = probes.map(marker => {
  const index = source.indexOf(marker, groupStart);
  assert.ok(index >= 0, `Coverage marker missing: ${marker}`);
  const line = source.slice(0, index).split("\n").length;
  const covered = Object.entries(entry.statementMap).some(([id, location]) =>
    location.start.line <= line && location.end.line >= line && entry.s[id] > 0);
  assert.ok(covered, `Changed line ${line} must execute`);
  return line;
});
const evidence = { passed: true, node: process.version,
  sourceHash: crypto.createHash("sha256").update(source).digest("hex"), focused: focusedResult,
  baseline, regressions: candidate, mutations, reordered, lint: lint.status, syntax: syntax.status,
  secrets: secrets.status, changedLinesCovered: coveredLines, propertyCases: 36,
  limitations: ["Full application suite not run; complete affected lifecycle suites compared against baseline.",
    "Existing repository type configuration excludes this JavaScript file from checked types.",
    "No browser UI changed; real HTTP save path exercised with synthetic records."] };
await writeFile(`${artifact}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
