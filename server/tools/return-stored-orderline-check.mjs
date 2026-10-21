import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { scanTextForSecrets } from "../test/support/scan-diff-secrets.mjs";

const out = resolve("test-artifacts/return-stored-orderline");
const runtime = ["src/return-netsuite.js", "src/return-stored-orderline.js"];
const focused = ["test/mbt/unit/return-stored-orderline.test.js", "test/mbt/integration/return-stored-orderline.test.js",
  "test/mbt/unit/return-batch-ra-domain.test.js", "test/mbt/unit/return-ra-workflow.test.js", "test/mbt/unit/return-ra-client.test.js",
  "test/mbt/integration/return-batch-ra.test.js", "test/mbt/integration/return-ra-workflow.test.js",
  "test/mbt/integration/stock-return-draft-insert.test.js", "test/mbt/integration/netsuite-order-line-storage.test.js",
  "test/mbt/integration/operator-direct-orderline.test.js"];
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
mkdirSync(out, { recursive: true });

function run(name, args, { cwd = process.cwd(), accepted = [0], input } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, input, encoding: "utf8", maxBuffer: 100e6, timeout: 300000 });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  writeFileSync(join(out, name + ".log"), output);
  assert.ok(accepted.includes(result.status), `${name}: exit ${result.status}; see ${name}.log`);
  return output;
}

function count(output) {
  const value = key => Number(output.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] || 0);
  return { tests: value("tests"), pass: value("pass"), fail: value("fail"), skipped: value("skipped") };
}

function lint(source, filename, name) {
  const args = ["node_modules/eslint/bin/eslint.js", "--config", "tools/return-stored-orderline-eslint.config.mjs", "--format=json"];
  const text = source === null ? run(name, [...args, filename], { accepted: [0, 1] })
    : run(name, [...args, "--stdin", "--stdin-filename", filename], { accepted: [0, 1], input: source });
  return JSON.parse(text).flatMap(file => file.messages.map(message => `${message.ruleId}:${message.message}`));
}

const before = readFileSync("/workspace/server/test-artifacts/return-stored-orderline/workspace-before/src/return-netsuite.js", "utf8");
const lintBefore = lint(before, runtime[0], "lint-baseline-wrapper");
const lintAfter = lint(null, runtime[0], "lint-final-wrapper");
const retained = [...lintBefore];
const lintNew = lintAfter.filter(message => { const index = retained.indexOf(message); if (index < 0) return true; retained.splice(index, 1); return false; });
assert.deepEqual(lintNew, []);
for (const file of [runtime[1], focused[0], focused[1]]) assert.deepEqual(lint(null, file, "lint-" + file.replaceAll("/", "-")), []);
run("types", ["node_modules/typescript/bin/tsc", "--allowJs", "--checkJs", "--strict", "--noEmit", "--skipLibCheck", "--target", "es2023", "--module", "nodenext", runtime[1]]);
for (const file of runtime) run("syntax-" + file.split("/").at(-1), ["--check", file]);
const changed = [runtime[1], focused[0], focused[1], "tools/return-stored-orderline-live.mjs", "tools/return-stored-orderline-isolated.sh"];
assert.deepEqual(changed.flatMap(file => scanTextForSecrets(readFileSync(file, "utf8"), file)), []);
const added = readFileSync(runtime[0], "utf8").split("\n").filter(line => !before.split("\n").includes(line)).join("\n");
assert.deepEqual(scanTextForSecrets(added, runtime[0]), []);

rmSync(join(out, "coverage"), { recursive: true, force: true });
// Collect the large existing caller for changed-line verification. Its untouched
// functions are outside this change; enforce the normal thresholds on the new
// mapper here and every changed caller line in the outer gauntlet.
const tests = count(run("focused", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false", "--include=src/return-stored-orderline.js",
  "--include=src/return-netsuite.js", "--reporter=json", "--reporter=json-summary", "--report-dir=" + join(out, "coverage"),
  "--temp-directory=" + join(out, "coverage", "tmp"), process.execPath, "--test", "--test-concurrency=1", ...focused]));
assert.equal(tests.fail, 0);
assert.ok(tests.pass > 0);
const mappingCoverage = JSON.parse(readFileSync(join(out, "coverage", "coverage-summary.json"), "utf8"))["/app/src/return-stored-orderline.js"];
for (const [metric, minimum] of [["lines", 95], ["statements", 95], ["functions", 95], ["branches", 90]]) {
  assert.ok(mappingCoverage[metric].pct >= minimum, `${metric} coverage of the new mapper is below ${minimum}%`);
}

// Shuffle file execution deterministically without changing any assertions.
const shuffled = [...focused];
let seed = 6642;
for (let index = shuffled.length - 1; index > 0; index -= 1) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  const target = seed % (index + 1);
  [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
}
const health = count(run("shuffled", ["--test", "--test-concurrency=1", ...shuffled]));
assert.equal(health.fail, 0);
assert.equal(health.pass, tests.pass);

const mutations = [
  ["wrong-order", runtime[1], "Number(row.sales_order_id) !== orderId ||", "false ||", true],
  ["wrong-item", runtime[1], "sourceId(row.item_id) !== sourceId(line.itemId)", "false", true],
  ["duplicate-rest-id", runtime[1], "if (seenRestIds.has(orderLine))", "if (false)", true],
  ["stable-key-posted", runtime[1], "netSuiteOrderLine: orderLine,", "netSuiteOrderLine: stableKey,", true],
  ["reject-every-valid-mapping", runtime[1], "return incomplete ? null : { ...order, lines };", "return null;", true],
  ["historical-fallback-lost", runtime[0], "const restItems = await fetchSalesOrderReturnLinesFromNetSuite(order.id);", "const restItems = [];", false],
  ["saved-mapping-unused", runtime[0], "if (mapped) {return mapped;}", "if (false) {return mapped;}", false],
  ["invalid-historical-id", runtime[0], "if (!Number.isSafeInteger(orderLine) || orderLine <= 0)", "if (false)", false],
  ["invalid-request-admitted", runtime[0], "assertReturnLineMappingInput(order);", "/* input guard omitted */", false]
];
const original = Object.fromEntries(runtime.map(file => [file, sha(file)]));
const mutationResults = [];
for (const [name, file, from, to, property] of mutations) {
  const folder = mkdtempSync(join(tmpdir(), "return-stored-mutant-"));
  try {
    for (const directory of ["src", "test"]) cpSync(directory, join(folder, directory), { recursive: true });
    cpSync("package.json", join(folder, "package.json"));
    symlinkSync(resolve("node_modules"), join(folder, "node_modules"), "dir");
    const code = readFileSync(join(folder, file), "utf8");
    assert.equal(code.split(from).length, 2, name);
    writeFileSync(join(folder, file), code.replace(from, to));
    const selected = property ? focused[0] : focused[1];
    assert.match(run("mutant-" + name, ["--test", selected], { cwd: folder, accepted: [1] }), /^not ok /m);
    if (property) assert.match(run("mutant-property-" + name, ["--test", "--test-name-pattern=generated", selected],
      { cwd: folder, accepted: [1] }), /^not ok /m);
    mutationResults.push({ name, killed: true, propertyOnlyKilled: property });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
assert.deepEqual(Object.fromEntries(runtime.map(file => [file, sha(file)])), original);
const restored = count(run("restored", ["--test", "--test-concurrency=1", focused[0], focused[1]]));
assert.equal(restored.fail, 0);
const versions = { node: process.version };
for (const name of ["typescript", "eslint", "fast-check", "c8", "pg"]) versions[name] = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
writeFileSync(join(out, "checks.json"), JSON.stringify({ passed: true, sourceHashes: original, tests, shuffled: { ...health, seed: 6642 },
  strictTypes: true, lint: { baselineFindings: lintBefore.length, finalFindings: lintAfter.length, newFindings: lintNew },
  secretFindings: 0, mutations: mutationResults, properties: { count: 2, casesEach: 200, seeds: [6642, 6643] }, restored, versions }, null, 2) + "\n");
console.log(JSON.stringify({ passed: true, tests, mutantsKilled: mutationResults.length, sourceHashes: original }));
