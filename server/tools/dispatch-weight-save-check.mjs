import assert from "node:assert/strict";
import path from "node:path";
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const production = ["src/dispatch-plan-repository.js", "src/dispatch-load-assignment.js", "src/dispatch-executed-order-review.js", "src/dispatch-planner-performance.js"];
const regression = ["test/dispatch/unit/dispatch-weight-save.test.js", "test/dispatch/integration/dispatch-weight-save.test.js"];
const artifact = path.resolve("test-artifacts/dispatch-weight-save");
const baseline = "/workspace/server/test-artifacts/dispatch-weight-save/baseline";
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
mkdirSync(artifact, { recursive: true });

function copySource() {
  const target = mkdtempSync(path.join(tmpdir(), "dispatch-weight-save-"));
  for (const file of ["src", "public", "test", "tools", "contracts", "migrations", "package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) {
    cpSync(file, path.join(target, file), { recursive: true });
  }
  symlinkSync(path.resolve("node_modules"), path.join(target, "node_modules"));
  mkdirSync(path.join(target, "test-artifacts"));
  return target;
}

function command(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (result.error) {throw result.error;}
  return result;
}

async function capturedSuite(files, root, label) {
  let output = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => { output += String(chunk); return original(chunk, ...args); };
  let status;
  try {status = await runNodeTestFilesIsolated(files.map(file => path.join(root, file)), { environment, label });}
  finally {process.stdout.write = original;}
  const failures = [...new Set([...output.matchAll(/^✖ (.+) \([\d.]+ms\)$/gmu)].map(match => match[1]))].sort();
  assert.equal(status === 0, failures.length === 0, "unexpected test process failure");
  const sum = key => [...output.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, "gmu"))].reduce((total, match) => total + Number(match[1]), 0);
  writeFileSync(path.join(artifact, `${label}.log`), output);
  return { status, tests: sum("tests"), passed: sum("pass"), failed: sum("fail"), failures };
}

async function suites() {
  const source = readFileSync("tools/executed-order-review-suites.mjs", "utf8");
  const adjacent = [...new Set([...source.matchAll(/"(test\/[^"]+\.(?:js|mjs))"/gu)].map(match => match[1]).concat([
    "test/dispatch/integration/dispatch-weight-source-review.test.js",
    "test/dispatch/integration/dispatch-executed-review-active-lines.test.js",
    "test/dispatch/property/dispatch-planned-source-review.test.js",
    "test/dispatch/unit/dispatch-performance-contract.test.js",
    "test/dispatch/adversarial/dispatch-performance-safety.test.js",
    "test/dispatch/property/dispatch-performance-command.property.test.js"
  ]))];
  let seed = 29092026;
  for (let i = adjacent.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [adjacent[i], adjacent[j]] = [adjacent[j], adjacent[i]];
  }
  const target = copySource();
  try {
    for (const file of production) {cpSync(path.join(baseline, path.basename(file)), path.join(target, file));}
    const before = await capturedSuite(adjacent, target, "baseline");
    const current = await capturedSuite([...regression, ...adjacent], process.cwd(), "current");
    assert.deepEqual(current.failures, before.failures, "no new failures");
    writeFileSync(path.join(artifact, "suites.json"), JSON.stringify({ before, current }));
  } finally {rmSync(target, { recursive: true, force: true });}
}

async function focused() {
  const result = await capturedSuite([...regression, "test/dispatch/integration/dispatch-weight-source-review.test.js"], process.cwd(), "focused");
  writeFileSync(path.join(artifact, "focused.json"), JSON.stringify(result));
  assert.equal(result.status, 0);
}

async function mutations() {
  const mutants = [
    [production[0], "Math.round(items.reduce((sum, item) => sum + numberValue(item.lineWeight), 0) * 1000) / 1000", "items.reduce((sum, item) => sum + numberValue(item.lineWeight), 0)", regression[1]],
    [production[1], "// Derived weight is informational; physical cargo quantities remain locked.", "dropWeight: stop.dropWeight ?? stop.weight ?? null,", regression[0]],
    [production[2], "reviewableSourceChanges(executedOrderChanges(before, after))", "executedOrderChanges(before, after)", regression[0]],
    [production[2], "reviewableSourceChanges(updated ? executedOrderChanges(child, updated) : [{ field: \"order_removed\", before: identity(child), after: null }])", "(updated ? executedOrderChanges(child, updated) : [{ field: \"order_removed\", before: identity(child), after: null }])", regression[0]],
    [production[3], "// The lane-prefix identity check protects actual load order, not number gaps.", "driverSequence: row.driverSequence,", regression[0]],
    [production[1], "positions.get(plan).get(text(row.load.id || row.load.loadId))", "row.driverSequence", regression[0]],
    [production[1], "items: semanticAllocationItems(order.items || [])", "items: []", regression[0]],
    [production[3], "Math.max(protectedByLoad.get(loadId) ?? -1, index)", "physical.length - 1", regression[0]]
  ];
  const results = [];
  for (const [index, [file, from, to, testFile]] of mutants.entries()) {
    const target = copySource();
    try {
      const original = readFileSync(path.join(target, file), "utf8");
      assert.equal(original.split(from).length, 2, `unique mutant ${index + 1}`);
      writeFileSync(path.join(target, file), original.replace(from, to));
      assert.equal(command(["--check", file], target).status, 0);
      const result = await capturedSuite([testFile], target, `mutant-${index + 1}`);
      results.push({ index: index + 1, file, killed: result.status === 1, failures: result.failures });
      assert.equal(result.status, 1, `mutant ${index + 1} survived`);
    } finally {rmSync(target, { recursive: true, force: true });}
  }
  writeFileSync(path.join(artifact, "mutations.json"), JSON.stringify(results));
}

function staticChecks() {
  const target = copySource();
  const files = [...production, ...regression, "tools/dispatch-weight-save-check.mjs"];
  const results = [];
  try {
    for (const file of production) {cpSync(path.join(baseline, path.basename(file)), path.join(target, file));}
    for (const [label, cwd] of [["baseline", target], ["current", process.cwd()]]) {
      const config = path.join(artifact, `${label}-eslint.config.mjs`);
      writeFileSync(config, `import base from ${JSON.stringify(path.join(cwd, "tools/executed-order-review-eslint.config.mjs"))}; export default [{...base[0],files:${JSON.stringify(files)}}];`);
      const lint = command(["node_modules/eslint/bin/eslint.js", "--config", config, "--format", "json", ...files], cwd);
      assert.equal(lint.stderr, "");
      const findings = JSON.parse(lint.stdout).flatMap(file => file.messages.map(message => ({
        file: path.relative(cwd, file.filePath), rule: message.ruleId, severity: message.severity,
        message: message.message.replace(/on line \d+ column \d+/gu, "on line,column")
      })));
      const types = command(["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], cwd);
      assert.equal(types.stderr, "");
      writeFileSync(path.join(artifact, `${label}-lint.json`), lint.stdout);
      writeFileSync(path.join(artifact, `${label}-types.log`), types.stdout);
      const diagnostics = types.stdout.replace(/^(?:\.\.\/)+app\//gmu, "").replace(/\(\d+,\d+\)/gu, "(line,column)").trim().split(/\n(?=\S)/u);
      results.push({ lint: findings, types: [...new Set(diagnostics)].sort() });
    }
    assert.deepEqual(results[1], results[0], "no new static diagnostics");
    assert.equal(results[1].lint.filter(finding => !production.includes(finding.file)).length, 0, "new files are lint clean");
    for (const file of files) {assert.equal(command(["--check", file]).status, 0);}
    writeFileSync(path.join(artifact, "static.json"), JSON.stringify({ noNewDiagnostics: true, existingLint: results[1].lint.length,
      existingTypes: results[1].types.filter(line => /error TS/u.test(line)).length }));
  } finally {rmSync(target, { recursive: true, force: true });}
}

const phase = process.argv[2] || "focused";
if (phase === "suites") {await suites();}
if (phase === "focused") {await focused();}
if (phase === "mutations") {await mutations();}
if (phase === "static") {staticChecks();}
if (phase === "red") {
  const result = await capturedSuite(regression, process.cwd(), "red");
  assert.equal(result.status, 1);
  writeFileSync(path.join(artifact, "red.json"), JSON.stringify(result));
}
writeFileSync(path.join(artifact, "source-hashes.json"), JSON.stringify(Object.fromEntries([...production, ...regression,
  "tools/dispatch-weight-save-check.mjs"].map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])), null, 2));
