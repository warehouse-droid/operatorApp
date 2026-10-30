// Run only through docker/run-dependency-pickup-checks.sh. Raw outputs are disposable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const read = path => readFileSync(path, "utf8");
const inputs = JSON.parse(read("test-artifacts/inputs.json"));
const files = Object.keys(inputs.files);
const originals = Object.fromEntries(files.map(file => [file, read(file)]));
const focused = ["test/dispatch/unit/dependency-pickup-reconciliation.test.js",
  "test/dispatch/integration/dependency-pickup-reconciliation.test.js"];
const management = JSON.parse(read("package.json")).scripts["test:scm-dependency-management"].split(" ").filter(arg => arg.startsWith("test/"));
const related = [
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
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
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
function types(name) {
  const result = run(name, "node_modules/.bin/tsc", ["--noEmit", "--allowJs", "--checkJs", "--skipLibCheck",
    "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", ...files]);
  return [...new Set(result.output.split("\n").filter(line => line.includes("error TS"))
    .map(line => line.replace(/\(\d+,\d+\)/u, "(line)")))].sort();
}
function mutations() {
  const reconciler = "src/scm-dependency-plan-reconciler.js";
  const cases = [
    ["obsolete allocation survives", reconciler, "dispatchPickupVisitLocationAllowed(order, stop.location)", "true"],
    ["unrelated references pruned", reconciler, "if (!affected.has(key) || !order)", "if (!order)"],
    ["unknown reference pruned", reconciler, "if (!affected.has(key) || !order)", "if (!affected.has(key))"],
    ["protected pickup pruned", reconciler, "stop => protectedIds.has(text(stop.id))\n    ? stop", "stop => false\n    ? stop"],
    ["shared allocation not added", reconciler, "priorPickup.orderRefs = refs([...priorPickup.orderRefs, targetRef]);", "priorPickup.orderRefs = refs(priorPickup.orderRefs);"],
    ["repeat visit duplicated", reconciler, "priorPickups.find(stop => refs(stop.orderRefs || [stop.orderId]).includes(targetRef))", "priorPickups[0]"],
    ["configured empty visit rejected", "src/dispatch-pickup-visits.js", "wanted && configuredPickupVisitLocations(order)", "wanted && dispatchRequiredPickupVisitLocations(order)"]
  ];
  for (const [name, file, from, to] of cases) {
    assert.equal(originals[file].split(from).length, 2, name);
    try {
      writeFileSync(file, originals[file].replace(from, to));
      const result = tests(`mutant-${report.mutations.length}`, [focused[0]]);
      assert.ok(result.fail > 0 && result.status !== 0, `Surviving mutant: ${name}`);
      report.mutations.push({ name, killed: true });
    } finally { restore(); }
  }
}
function coverage() {
  const selected = [...focused, ...suite];
  const result = run("coverage", "node_modules/.bin/c8", ["--all=false", "--check-coverage=false",
    ...files.map(file => `--include=${file}`),
    "--temp-directory=test-artifacts/c8", "--report-dir=test-artifacts/coverage", "--reporter=json", "--reporter=json-summary",
    process.execPath, "--test", "--test-concurrency=1", ...selected]);
  report.suite = testResult(result);
  assert.deepEqual(report.suite.failures, report.baseline.failures, "New suite failures");
  const data = JSON.parse(read("test-artifacts/coverage/coverage-final.json"));
  report.changedLineCoverage = files.map(file => {
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
  console.log("Checking baseline regression suites and static diagnostics.");
  for (const file of files) { writeFileSync(file, read(`baseline/${file}`)); }
  report.baseline = tests("baseline", suite);
  const beforeTypes = types("types-baseline");
  restore();
  resetDatabase();
  report.focused = tests("focused", focused);
  assert.equal(report.focused.fail, 0, "Focused regression failed; see focused.log");
  assert.equal(report.focused.status, 0);
  const afterTypes = types("types-candidate");
  const newDiagnostics = afterTypes.filter(line => !beforeTypes.includes(line));
  report.types = { baselineDiagnostics: beforeTypes.length, candidateDiagnostics: afterTypes.length, newDiagnostics };
  assert.deepEqual(newDiagnostics, []);
  writeFileSync("test-artifacts/eslint.config.mjs", `import base from '../eslint.mbt.config.js';
export default [...base, {files:['src/dispatch-pickup-visits.js'],languageOptions:{globals:{structuredClone:'readonly'}},
rules:{'no-undef':'error','no-unused-vars':['error',{args:'none'}],'no-unreachable':'error','no-constant-condition':'error'}}];`);
  const lint = run("lint", "node_modules/.bin/eslint", ["--config", "test-artifacts/eslint.config.mjs", "--max-warnings=0",
    ...files, ...focused]);
  report.lint = lint.status;
  assert.equal(lint.status, 0, lint.output);
  const secrets = run("secrets", process.execPath, ["test/support/scan-diff-secrets.mjs", ...files, ...focused, "tools/dependency-pickup-gauntlet.mjs"]);
  report.secretScan = secrets.status;
  assert.equal(secrets.status, 0, secrets.output);
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
    "Browser end-to-end skipped: no UI or request contract changed; real command service and plan persistence exercised."];
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  restore();
  writeFileSync("test-artifacts/dependency-pickup-evidence.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
