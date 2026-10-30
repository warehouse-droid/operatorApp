// Run only through docker/run-dependency-cache-checks.sh. Raw outputs are disposable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const read = path => readFileSync(path, "utf8");
const inputs = JSON.parse(read("test-artifacts/inputs.json"));
const files = Object.keys(inputs.files);
const originals = Object.fromEntries(files.map(file => [file, read(file)]));
const focused = ["test/dispatch/unit/dependency-pickup-cache.test.js",
  "test/dispatch/integration/dependency-pickup-cache.test.js",
  "test/dispatch/frontend/dependency-pickup-cache.browser.test.mjs"];
const management = JSON.parse(read("package.json")).scripts["test:scm-dependency-management"].split(" ").filter(arg => arg.startsWith("test/"));
const related = [
  "test/dispatch/unit/dependency-pickup-reconciliation.test.js",
  "test/dispatch/integration/dependency-pickup-reconciliation.test.js",
  "test/dispatch/integration/dispatch-global-order-group-pool.red.test.js",
  "test/dispatch/integration/dispatch-order-catalog.red.test.js",
  "test/dispatch/integration/order-dependency-multi-to-extension.red.test.js",
  "test/dispatch/frontend/sales-order-group-hydration.red.test.js",
  "test/dispatch/frontend/group-hydration-concurrency.test.js",
  "test/dispatch/frontend/dispatch-source-refresh.test.js",
  "test/dispatch/property/dispatch-source-refresh.property.test.js",
  "test/dispatch/property/dispatch-global-order-group-pool.property.test.js",
  "test/mbt/unit/dispatch-plan-authoritative-projection.red.test.js",
  "test/mbt/unit/driver-repeat-pickup-visits.red.test.js",
  "test/dispatch/unit/dispatch-repeat-pickup-visits.red.test.js",
  "test/dispatch/unit/dispatch-po-route-residual.red.test.js",
  "test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js",
  "test/dispatch/adversarial/dispatch-repeat-pickup-visits.adversarial.test.js",
  "test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js",
  "test/dispatch/concurrency/dispatch-repeat-pickup-command.red.test.js",
  "test/dispatch/concurrency/dispatch-plan-authoritative-projection-concurrency.red.test.js",
  "test/dispatch/integration/dispatch-plan-authoritative-projection.red.test.js",
  "test/dispatch/integration/dispatch-required-pickups-save.test.js",
  "test/dispatch/integration/to-dependency-packing-independent.test.js",
  "test/dispatch/property/dispatch-repeat-pickup-visits.property.test.js",
  "test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js",
  "test/dispatch/property/dispatch-po-route-residual.property.test.js"
];
const suite = [...new Set([...management, ...related])];
const report = { passed: false, ...inputs, specApproval: "not obtained (autonomous run)",
  scope: "Full dependency-management suite plus pickup, projection, residual, concurrency and command regression suites; unrelated product suites excluded.",
  mutations: [], versions: { node: process.version, tools: {} } };
for (const name of ["typescript", "eslint", "c8", "fast-check"]) {
  report.versions.tools[name] = JSON.parse(read(`node_modules/${name}/package.json`)).version;
}
function run(name, command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 360000, maxBuffer: 16 * 1024 * 1024 });
  const output = (result.stdout || "") + (result.stderr || "");
  writeFileSync(`test-artifacts/${name}.log`, output);
  assert.ifError(result.error);
  return { status: result.status, output };
}
function testResult(result) {
  const count = key => Number(result.output.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] || 0);
  return { status: result.status, tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"),
    failures: [...result.output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort(),
    failureDetails: [...result.output.matchAll(/^not ok \d+ - (.+)\n([\s\S]*?)^  \.\.\.$/gm)]
      .map(match => ({ test: match[1], details: match[2].split("\n").filter(line => !line.includes("duration_ms") && !line.includes("location:")).slice(0, 12).join("\n") })) };
}
function resetDatabase() {
  const code = `import assert from 'node:assert/strict'; import {query,closeDb} from './src/db.js';
try { assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const {rows}=await query('SELECT current_database() AS db,current_user AS role');
assert.deepEqual(rows,[{db:'mbt_test',role:'mbt_test'}]);
const tables=await query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
for(const row of tables.rows) { await query('DROP TABLE IF EXISTS public."'+row.tablename.replaceAll('"','""')+'" CASCADE'); }
await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); } finally { await closeDb(); }`;
  const reset = run("reset-db", process.execPath, ["--input-type=module", "-e", code]);
  assert.equal(reset.status, 0, reset.output);
  const migrate = run("reset-migrate", process.execPath, ["src/migrate.js"]);
  assert.equal(migrate.status, 0, migrate.output);
}
function tests(name, selected) {
  const result = run(name, process.execPath, ["--test", "--test-concurrency=1", ...selected]);
  return testResult(result);
}
function restore() {
  for (const file of files) { writeFileSync(file, originals[file]); }
}
const typeMessages = {};
function types(name) {
  const result = run(name, "node_modules/.bin/tsc", ["--noEmit", "--allowJs", "--checkJs", "--skipLibCheck",
    "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", ...files.filter(file => file.endsWith(".js"))]);
  typeMessages[name] = {};
  for (const line of result.output.split("\n")) {
    const match = line.match(/^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/u);
    if (!match) {continue;}
    // Unchanged callers can report the same existing error using the new,
    // more precise return-type name. Compare those by exact location/code,
    // and retain every changed message in the evidence instead of hiding it.
    const key = files.includes(match[1])
      ? `${match[1]}(line): error ${match[4]}: ${match[5]}`
      : `${match[1]}(${match[2]},${match[3]}): error ${match[4]}`;
    typeMessages[name][key] = match[5];
  }
  return Object.keys(typeMessages[name]).sort();
}
function mutations() {
  const projection = "src/dispatch-plan-order-projection.js";
  const cases = [
    ["obsolete TO yard survives", projection, "!previous.some(candidate => scmDependencyLocationsMatch(candidate, location))\n      || retained.some", "true\n      || retained.some", true],
    ["native or PO yard removed", projection, "|| retained.some(candidate => scmDependencyLocationsMatch(candidate, location)));\n  }", "|| false);\n  }", true],
    ["nested stale dependency survives", projection, "next.childOrderDetails = order.childOrderDetails.map(stripDispatchTransferDependencyProjection);", "next.childOrderDetails = order.childOrderDetails;", true],
    ["current child links not projected", "src/order-dependency-repository.js", "childOrderDetails: snapshot.childOrderDetails.map(project)", "childOrderDetails: snapshot.childOrderDetails"],
    ["catalogue returns stale projection", "src/dispatch-order-catalog-repository.js", "const current = await enrichDispatchOrdersWithDependencies(canonical);", "const current = canonical;"],
    ["browser catalogue overrides saved dependency", "public/dispatch.js", "preserveActiveOrderEvidence(order, withSavedDependencyProjection({", "preserveActiveOrderEvidence(order, ((value) => value)({"],
    ["in-flight response skips reconciliation", "public/dispatch.js", "if (!mergeAcknowledgedDependencyPlan(payload.plan))", "if (false)"],
    ["conflict fails to fence autosave", "public/dispatch.js", "blockedPlanSaveFence = { planId: String(currentPlan?.id || \"\"), message: routeNotice };", "blockedPlanSaveFence = null;"]
  ];
  for (const [name, file, from, to, property] of cases) {
    assert.equal(originals[file].split(from).length, 2, name);
    try {
      writeFileSync(file, originals[file].replace(from, to));
      const selected = property ? [focused[0]] : file.startsWith("public/") ? [focused[2]] : [focused[1]];
      const result = tests(`mutant-${report.mutations.length}`, selected);
      assert.ok(result.fail > 0 && result.status !== 0, `Surviving mutant: ${name}`);
      report.mutations.push({ name, killed: true, propertyOnly: Boolean(property) });
    } finally { restore(); }
  }
}
function lint(name, extra = []) {
  const result = run(name, "node_modules/.bin/eslint", ["--config", "test-artifacts/eslint.config.mjs", "--format=json",
    ...files.filter(file => file.endsWith(".js")), ...extra]);
  assert.ok(result.output.trimStart().startsWith("["), result.output);
  const data = JSON.parse(result.output);
  return data.flatMap(entry => entry.messages.map(message => entry.filePath.split("/candidate/").pop() + ":" + message.ruleId + ":" + message.message)).sort();
}
function coverage() {
  const selected = [...focused, ...suite];
  process.env.DEPENDENCY_CACHE_COVERAGE_DIR = "test-artifacts/c8";
  const result = run("coverage", "node_modules/.bin/c8", ["--all=false", "--check-coverage=false",
    ...files.map(file => `--include=${file}`),
    "--temp-directory=test-artifacts/c8", "--report-dir=test-artifacts/coverage", "--reporter=json", "--reporter=json-summary",
    process.execPath, "--test", "--test-concurrency=1", ...selected]);
  delete process.env.DEPENDENCY_CACHE_COVERAGE_DIR;
  report.suite = testResult(result);
  assert.deepEqual(report.suite.failures, report.baseline.failures, "New suite failures");
  const data = JSON.parse(read("test-artifacts/coverage/coverage-final.json"));
  report.changedLineCoverage = files.filter(file => file.endsWith(".js")).map(file => {
    const entry = Object.entries(data).find(([path]) => path.endsWith(`/${file}`))?.[1];
    assert.ok(entry, `Missing coverage: ${file}`);
    const source = originals[file].split("\n");
    const lines = inputs.changedLines[file].filter(line => source[line - 1].trim() && !source[line - 1].trim().startsWith("//"));
    const covered = lines.filter(line => Object.entries(entry.statementMap).some(([id, range]) =>
      range.start.line <= line && range.end.line >= line && entry.s[id] > 0));
    assert.deepEqual(covered, lines, `Uncovered changes: ${file}`);
    return { file, covered: covered.length, total: lines.length };
  });
}
try {
  const secrets = run("secrets", process.execPath, ["test/support/scan-diff-secrets.mjs",
    "--unified-diff", "test-artifacts/runtime.patch", ...focused,
    "test/support/dependency-pickup-cache-fixture.mjs", "tools/dependency-cache-gauntlet.mjs"]);
  report.secretScan = secrets.status;
  assert.equal(secrets.status, 0, secrets.output);
  console.log("Checking baseline regression suites and static diagnostics.");
  for (const file of files) { writeFileSync(file, read(`baseline/${file}`)); }
  const beforeTypes = types("types-baseline");
  writeFileSync("test-artifacts/eslint.config.mjs", `import base from '../eslint.mbt.config.js';
export default [...base, {files:['src/dispatch-plan-order-projection.js','src/order-dependency-repository.js','src/dispatch-order-catalog-repository.js','public/dispatch.js','test/dispatch/**/*.mjs'],
languageOptions:{globals:{...base[0].languageOptions.globals,window:'readonly',document:'readonly',navigator:'readonly',localStorage:'readonly',sessionStorage:'readonly',location:'readonly',requestAnimationFrame:'readonly',HTMLElement:'readonly',Node:'readonly',Event:'readonly',MutationObserver:'readonly',getComputedStyle:'readonly',requireDispatchLogin:'readonly'}},rules:{'no-undef':'error','no-unused-vars':['error',{args:'none',varsIgnorePattern:'^_'}],'no-unreachable':'error','no-constant-condition':'error'}},
// Playwright setup writes globals consumed by the actual browser application.
{files:['test/dispatch/frontend/dependency-pickup-cache.browser.test.mjs'],rules:{'no-unused-vars':['error',{vars:'local',args:'none'}]}}];`);
  const beforeLint = lint("lint-baseline");
  restore();
  const afterTypes = types("types-candidate");
  const newDiagnostics = afterTypes.filter(line => !beforeTypes.includes(line));
  report.types = { baselineDiagnostics: beforeTypes.length, candidateDiagnostics: afterTypes.length, newDiagnostics,
    changedExistingDiagnostics: afterTypes.filter(key => beforeTypes.includes(key)
      && typeMessages["types-baseline"][key] !== typeMessages["types-candidate"][key])
      .map(key => ({ location: key, before: typeMessages["types-baseline"][key], after: typeMessages["types-candidate"][key] })) };
  assert.deepEqual(newDiagnostics, []);
  const afterLint = lint("lint-candidate", focused);
  const newLint = afterLint.filter(line => !beforeLint.includes(line));
  report.lint = { baseline: beforeLint.length, candidate: afterLint.length, newDiagnostics: newLint };
  assert.deepEqual(newLint, []);
  for (const file of files) {writeFileSync(file, read(`baseline/${file}`));}
  report.baseline = tests("baseline", suite);
  restore();
  resetDatabase();
  report.focused = tests("focused", focused);
  assert.equal(report.focused.fail, 0, "Focused regression failed; see focused.log");
  assert.equal(report.focused.status, 0);
  console.log("Checking deliberate bugs, then running the final suite with coverage.");
  mutations();
  resetDatabase();
  coverage();
  report.reverseOrder = tests("reverse-order", [...focused].reverse());
  assert.equal(report.reverseOrder.status, 0);
  report.files = Object.fromEntries(files.map(file => [file, createHash("sha256").update(read(file)).digest("hex")]));
  assert.deepEqual(report.files, inputs.files);
  report.supplyChain = "No dependency changes. Runtime change adds no network, filesystem, subprocess or environment capabilities.";
  report.knownLimits = ["Legacy TypeScript diagnostics are compared with baseline; this is not a fully typed codebase.",
    "Browser network boundaries are stubbed; pickup acceptance uses the real server validator and database command suites run separately.",
    "Unrelated product suites are outside this dispatch change. Existing suite failures are compared with the exact live image."];
  for (const html of files.filter(file => file.endsWith(".html"))) {
    assert.ok(read(html).includes('/dispatch.js?v=20261030-dependency-cache'));
  }
  report.assetCacheVersion = "20261030-dependency-cache (both entry pages checked)";
  report.red = "Before implementation: 6 reproducing failures, 1 existing passing browser-save scenario. A later compact-pool regression also failed on the obsolete 2967 yard before its fix. Initial fixture/schema and incremental-save mock corrections were completed before the behavioral red runs.";
  report.scannerScope = "All changed runtime lines and complete new tests/fixture/gauntlet. An initial full-file scan matched two unchanged source-review HTML interpolations; neither was a credential or part of this patch.";
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  restore();
  writeFileSync("test-artifacts/dependency-cache-evidence.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, error: report.error, focused: report.focused,
    baseline: report.baseline, suite: report.suite, types: report.types, lint: report.lint,
    mutations: report.mutations, changedLineCoverage: report.changedLineCoverage, reverseOrder: report.reverseOrder }, null, 2));
}
