import assert from "node:assert/strict";
import path from "node:path";
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";
import v8toIstanbul from "v8-to-istanbul";

const artifact = path.resolve("test-artifacts/pickup-override");
const production = ["public/dispatch.js", "src/dispatch-pickup-visits.js", "src/scm-dependency-plan-reconciler.js"];
const regression = "test/dispatch/frontend/dispatch-pickup-address-grouping.test.js";
const browserTest = "test/dispatch/frontend/dispatch-pickup-address.browser.test.mjs";
const adjacent = JSON.parse(readFileSync("package.json", "utf8")).scripts["test:dispatch-repeat-pickup"].split(" ").filter(value => value.endsWith(".js"));
adjacent.push("test/mbt/unit/scm-dependency-plan-reconciler.red.test.js", "test/dispatch/integration/dispatch-required-pickups-save.test.js");
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
const baselineRoot = "/workspace/server/test-artifacts/dispatch-pickup-override/baseline";
mkdirSync(artifact, { recursive: true });

function command(args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 40 * 1024 * 1024, ...options });
  if (result.error) { throw result.error; }
  return result;
}

function sourceCopy(baseline = false) {
  const target = mkdtempSync(path.join(tmpdir(), "dispatch-pickup-address-"));
  for (const name of ["src", "public", "test", "tools", "contracts", "migrations"]) { cpSync(name, path.join(target, name), { recursive: true }); }
  for (const name of ["package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) { cpSync(name, path.join(target, name)); }
  symlinkSync(path.resolve("node_modules"), path.join(target, "node_modules"));
  mkdirSync(path.join(target, "test-artifacts"));
  if (baseline) { for (const name of [...production, "public/dispatch.html"]) { cpSync(path.join(baselineRoot, name), path.join(target, name)); } }
  return target;
}

async function suites() {
  const target = sourceCopy(true);
  const result = {};
  try {
    for (const [label, cwd] of [["baseline", target], ["current", process.cwd()]]) {
      const run = command(["--test", "--test-concurrency=1", ...adjacent], { cwd, env: environment });
      writeFileSync(path.join(artifact, `${label}-adjacent.log`), run.stdout + run.stderr);
      result[label] = { failures: run.stdout.split("\n").filter(line => line.startsWith("not ok ")).map(line => line.replace(/^not ok \d+ - /u, "")),
        tests: Number(run.stdout.match(/# tests (\d+)/u)?.[1]), passes: Number(run.stdout.match(/# pass (\d+)/u)?.[1]) };
      result[label].harnesses = [];
      for (const harness of ["src/dispatch-pickup-override-harness.js", "src/dispatch-load-assignment-harness.js"]) {
        const checked = command([harness], { cwd, env: environment });
        writeFileSync(path.join(artifact, `${label}-${path.basename(harness)}.log`), checked.stdout + checked.stderr);
        result[label].harnesses.push({ harness, status: checked.status,
          failure: checked.stderr.match(/AssertionError.*\n/u)?.[0]?.trim() || "" });
      }
    }
    assert.deepEqual(result.current.failures, result.baseline.failures);
    assert.deepEqual(result.current.harnesses, result.baseline.harnesses);
    assert.ok(result.current.tests > 54);
    writeFileSync(path.join(artifact, "suites.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ adjacent: result }));
    const red = command(["--test", regression], { cwd: target, env: environment });
    assert.equal(red.status, 1);
    assert.match(red.stdout, /not ok .*SCM reconciliation shares an identical override/u);
    writeFileSync(path.join(artifact, "baseline-regressions.log"), red.stdout + red.stderr);
  } finally { rmSync(target, { recursive: true, force: true }); }
}

function mutations() {
  const mutants = [
    [production[0], "if (override) { return override; }", "if (false) { return override; }"],
    [production[0], "&& pickupStopMatchesOrder(stop, order)\n", "&& true\n"],
    [production[0], "&& pickupStopMatchesOrder(stop, order));", "&& true);"],
    [production[1], "return key(left) === key(right);", "return true;"],
    [production[0], 'stop.type !== "pick" || index <= boundary || stopHasDriverActivity(load, stop)', 'stop.type !== "pick" || stopHasDriverActivity(load, stop)']
  ];
  for (const [index, [file, from, to]] of mutants.entries()) {
    const target = sourceCopy();
    try {
      const original = readFileSync(path.join(target, file), "utf8");
      assert.equal(original.split(from).length, 2);
      writeFileSync(path.join(target, file), original.replace(from, to));
      assert.equal(command(["--check", path.join(target, file)]).status, 0);
      const run = command(["--test", regression], { cwd: target, env: environment });
      writeFileSync(path.join(artifact, `mutant-${index + 1}.log`), run.stdout + run.stderr);
      assert.equal(run.status, 1);
      assert.match(run.stdout, /not ok \d+ - /u);
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
  console.log("Pickup override mutations killed: 5/5");
}

function staticChecks() {
  const target = sourceCopy(true);
  try {
    const lintFiles = [...production, regression, "tools/dispatch-pickup-address-check.mjs"];
    const summaries = [];
    for (const [label, cwd] of [["baseline", target], ["current", process.cwd()]]) {
      const config = path.join(label === "baseline" ? target : artifact, "eslint.config.mjs");
      writeFileSync(config, `import base from ${JSON.stringify(path.join(cwd, "tools/executed-order-review-eslint.config.mjs"))}; export default [{...base[0],files:${JSON.stringify(lintFiles)}}];`);
      const lint = command(["node_modules/eslint/bin/eslint.js", "--config", config, "--format", "json", ...lintFiles], { cwd });
      assert.equal(lint.stderr, "");
      const messages = JSON.parse(lint.stdout).flatMap(file => file.messages.map(message => ({
        file: path.relative(cwd, file.filePath), rule: message.ruleId,
        message: message.message.replace(/on line \d+ column \d+/gu, "on line,column"), severity: message.severity
      })));
      const types = command(["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], { cwd });
      assert.equal(types.stderr, "");
      writeFileSync(path.join(artifact, `${label}-lint.json`), lint.stdout);
      writeFileSync(path.join(artifact, `${label}-types.log`), types.stdout);
      const diagnostics = types.stdout.replace(/^(?:\.\.\/)+app\//gmu, "").replace(/\(\d+,\d+\)/gu, "(line,col)").trim().split(/\n(?=\S)/u);
      summaries.push({ lint: messages, types: [...new Set(diagnostics)].sort() });
    }
    assert.deepEqual(summaries[1], summaries[0], "no new static diagnostics");
    assert.equal(summaries[1].lint.filter(message => [regression, "tools/dispatch-pickup-address-check.mjs"].includes(message.file)).length, 0);
    for (const file of [...lintFiles, browserTest]) { assert.equal(command(["--check", file]).status, 0); }
    console.log(JSON.stringify({ static: "no new diagnostics", existingLint: summaries[1].lint.length,
      existingTypeDiagnostics: summaries[1].types.filter(line => /error TS/u.test(line)).length }));
  } finally { rmSync(target, { recursive: true, force: true }); }
}

async function focused() {
  assert.equal(await runNodeTestFilesIsolated([regression, browserTest].map(file => path.resolve(file)), { environment, label: "Pickup address" }), 0);
  const coverage = JSON.parse(readFileSync(path.join(artifact, "browser-coverage.json"), "utf8"));
  const entry = coverage.find(value => new URL(value.url).pathname === "/dispatch.js");
  assert.ok(entry);
  const converter = v8toIstanbul(path.resolve(production[0]), 0, { source: entry.source });
  await converter.load(); converter.applyCoverage(entry.functions);
  writeFileSync(path.join(artifact, "browser-istanbul.json"), JSON.stringify(converter.toIstanbul()));
}

const phase = process.argv[2] || "all";
if (["all", "coverage"].includes(phase)) { await focused(); }
if (["all", "suites"].includes(phase)) { await suites(); }
if (["all", "mutations"].includes(phase)) { mutations(); }
if (["all", "static"].includes(phase)) { staticChecks(); }
writeFileSync(path.join(artifact, "source-hashes.json"), JSON.stringify(Object.fromEntries([...production, "public/dispatch.html", regression,
  browserTest, "tools/dispatch-pickup-address-check.mjs"].map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])), null, 2));
