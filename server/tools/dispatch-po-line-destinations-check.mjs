import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const production = ["src/dispatch-repository.js", "src/dispatch-planner-v2-repository.js", "src/dispatch-po-route-projection.js"];
const regression = "test/dispatch/unit/dispatch-po-line-destinations.test.js";
const artifact = path.resolve("test-artifacts/dispatch-po-line-destinations");
const baseline = path.resolve("/workspace/server/test-artifacts/dispatch-po-line-destinations/baseline");
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
mkdirSync(artifact, { recursive: true });
const save = (name, value) => writeFileSync(path.join(artifact, name), JSON.stringify(value, null, 2) + "\n");

function command(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  if (result.error) {throw result.error;}
  return result;
}

function sourceCopy(before = false) {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-po-destinations-"));
  for (const name of ["src", "public", "test", "tools", "contracts", "migrations", "package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) {
    cpSync(name, path.join(root, name), { recursive: true });
  }
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"));
  mkdirSync(path.join(root, "test-artifacts"));
  if (before) {
    for (const name of production) {cpSync(path.join(baseline, path.basename(name)), path.join(root, name));}
  }
  return root;
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(name) : /test\.(?:js|mjs)$/u.test(name) ? [name] : [];
  });
}

function addedLines(beforeSource, afterSource) {
  const before = beforeSource.split("\n");
  const after = afterSource.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {prefix += 1;}
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) {oldEnd -= 1; newEnd -= 1;}
  const left = before.slice(prefix, oldEnd);
  const right = after.slice(prefix, newEnd);
  const common = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let oldIndex = left.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = right.length - 1; newIndex >= 0; newIndex -= 1) {
      common[oldIndex][newIndex] = left[oldIndex] === right[newIndex]
        ? 1 + common[oldIndex + 1][newIndex + 1]
        : Math.max(common[oldIndex + 1][newIndex], common[oldIndex][newIndex + 1]);
    }
  }
  const lines = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (newIndex < right.length) {
    if (oldIndex < left.length && left[oldIndex] === right[newIndex]) {oldIndex += 1; newIndex += 1;}
    else if (oldIndex < left.length && common[oldIndex + 1][newIndex] >= common[oldIndex][newIndex + 1]) {oldIndex += 1;}
    else {if (right[newIndex].trim()) {lines.push(prefix + newIndex + 1);} newIndex += 1;}
  }
  return lines;
}

async function suite(files, root, label) {
  let output = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = chunk => { output += String(chunk); return true; };
  let status;
  try {status = await runNodeTestFilesIsolated(files.map(name => path.join(root, name)), { environment, label });}
  finally {process.stdout.write = original;}
  writeFileSync(path.join(artifact, label + ".log"), output);
  const count = key => [...output.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, "gmu"))].reduce((total, match) => total + Number(match[1]), 0);
  const failures = [...new Set([...output.matchAll(/^✖ (.+) \([\d.]+ms\)$/gmu)].map(match => match[1]))].sort();
  const result = { status, tests: count("tests"), passed: count("pass"), failed: count("fail"), failures };
  save(label + ".json", result);
  console.log(JSON.stringify({ label, ...result }));
  return result;
}

async function suites() {
  const adjacent = filesUnder("test/dispatch").filter(name => name !== regression);
  adjacent.push("test/mbt/unit/driver-live-route-prefix-lock.red.test.js",
    "test/mbt/integration/driver-live-route-prefix-lock.integration.test.js",
    "test/mbt/concurrency/driver-live-route-prefix-lock.concurrency.test.js");
  let seed = 1401728;
  for (let index = adjacent.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const chosen = seed % (index + 1); [adjacent[index], adjacent[chosen]] = [adjacent[chosen], adjacent[index]];
  }
  const root = sourceCopy(true);
  try {
    const before = await suite(adjacent, root, "baseline");
    const current = await suite([regression, ...adjacent], process.cwd(), "current");
    assert.deepEqual(current.failures, before.failures, "No new dispatch failures");
    assert.equal(current.failed, before.failed, "No new dispatch failures");
    save("suites.json", { before, current, randomizedSeed: 1401728, files: adjacent.length });
  } finally {rmSync(root, { recursive: true, force: true });}
}

function focused() {
  const files = [regression, "test/dispatch/unit/dispatch-po-route-residual.red.test.js",
    "test/dispatch/property/dispatch-po-route-residual.property.test.js",
    "test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js",
    "test/dispatch/frontend/dispatch-po-route-residual-ui.red.test.js"];
  const result = command(["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false", ...production.map(name => "--include=" + name),
    "--reporter=json", "--reporter=json-summary", "--report-dir=" + path.join(artifact, "coverage"),
    "--temp-directory=" + path.join(artifact, "c8"), "node", "--test", "--test-concurrency=1", ...files]);
  writeFileSync(path.join(artifact, "focused.log"), result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stderr + result.stdout.slice(-2000));
  const count = key => Number(new RegExp(`^# ${key} (\\d+)$`, "mu").exec(result.stdout)?.[1] || 0);
  save("focused.json", { status: result.status, tests: count("tests"), passed: count("pass"), failed: count("fail"),
    propertyExamples: 200, propertyReloads: 600 });
  const coverage = JSON.parse(readFileSync(path.join(artifact, "coverage/coverage-final.json"), "utf8"));
  const changedCoverage = [];
  for (const file of production) {
    const lines = addedLines(readFileSync(path.join(baseline, path.basename(file)), "utf8"), readFileSync(file, "utf8"));
    const entry = coverage[path.resolve(file)];
    assert.ok(entry, "Coverage exists for " + file);
    const coveredLines = new Set();
    for (const [key, statement] of Object.entries(entry.statementMap)) {
      if (entry.s[key] > 0) {
        for (let number = statement.start.line; number <= statement.end.line; number += 1) {coveredLines.add(number);}
      }
    }
    const missed = lines.filter(number => !coveredLines.has(number));
    changedCoverage.push({ file, total: lines.length, covered: lines.length - missed.length, missed });
    assert.deepEqual(missed, [], "Every changed line is exercised: " + file);
  }
  save("changed-line-coverage.json", changedCoverage);
  console.log(JSON.stringify({ focused: "passed", changedCoverage }));
}

function staticChecks() {
  const root = sourceCopy(true);
  const files = [...production, regression, "test/support/dispatch-po-line-destination-functions.mjs", "tools/dispatch-po-line-destinations-check.mjs"];
  const results = [];
  try {
    for (const [label, cwd] of [["before", root], ["current", process.cwd()]]) {
      const lintConfig = path.join(artifact, label + "-eslint.config.mjs");
      writeFileSync(lintConfig, `import base from ${JSON.stringify(path.join(cwd, "eslint.mbt.config.js"))}; export default [{...base[1],files:${JSON.stringify(files)}}];`);
      const lint = command(["node_modules/eslint/bin/eslint.js", "--config", lintConfig, "--format=json", ...files], cwd);
      assert.equal(lint.stderr, "");
      const findings = JSON.parse(lint.stdout).flatMap(entry => entry.messages.map(message => ({
        file: path.relative(cwd, entry.filePath), rule: message.ruleId, severity: message.severity, message: message.message
      })));
      const types = command(["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], cwd);
      writeFileSync(path.join(artifact, label + "-types.log"), types.stdout + types.stderr);
      save(label + "-lint.json", findings);
      const diagnostics = types.stdout.replaceAll(cwd, "/SOURCE").replace(/^(?:\.\.\/)+app\//gmu, "")
        .replace(/\(\d+,\d+\)/gu, "(line,column)").trim().split(/\n(?=\S)/u);
      results.push({ lint: findings, types: [...new Set(diagnostics)].sort() });
    }
    assert.deepEqual(results[1], results[0], "No new static diagnostics");
    assert.equal(results[1].lint.filter(finding => !production.includes(finding.file)).length, 0);
    for (const file of files) {assert.equal(command(["--check", file]).status, 0);}
    save("static.json", { noNewDiagnostics: true, existingLint: results[1].lint.length,
      existingTypes: results[1].types.filter(line => /error TS/u.test(line)).length });
  } finally {rmSync(root, { recursive: true, force: true });}
}

function mutations() {
  const mutants = [
    [production[1], '"dropoffs", "defaultDestinationAddress", "deliveryAddressOverride",', '"defaultDestinationAddress", "deliveryAddressOverride",', false],
    [production[1], '"dropoffs", "defaultDestinationAddress", "deliveryAddressOverride",', '"dropoffs",', false],
    [production[0], "projectPurchaseOrderRouteResidual(routeOrder, poAllocations", "projectPurchaseOrderRouteResidual(targetEnriched, poAllocations", true],
    [production[2], '(matchesHeaderDestination ? text(order.deliveryAddressOverride ?? order.delivery_address_override) : "")', 'text(order.deliveryAddressOverride ?? order.delivery_address_override)', false],
    [production[0], "projectPurchaseOrderRouteResidual(routeOrder, poAllocations", "projectPurchaseOrderRouteResidual({ ...routeOrder, items: [] }, poAllocations", true]
  ];
  const results = [];
  for (const [index, [file, from, to, propertyRelevant]] of mutants.entries()) {
    const root = sourceCopy();
    try {
      const source = readFileSync(path.join(root, file), "utf8");
      assert.equal(source.split(from).length, 2, "Unique mutation");
      writeFileSync(path.join(root, file), source.replace(from, to));
      const full = command(["--test", regression], root);
      assert.equal(full.status, 1, "Mutation killed " + (index + 1));
      const property = command(["--test", "--test-name-pattern=PDD-6", regression], root);
      if (propertyRelevant) {assert.equal(property.status, 1, "Property kills destination/cargo mutation " + (index + 1));}
      results.push({ index: index + 1, file, killed: true, propertyKilled: property.status === 1, propertyRelevant });
      writeFileSync(path.join(artifact, `mutation-${index + 1}.log`), full.stdout + full.stderr + property.stdout + property.stderr);
    } finally {rmSync(root, { recursive: true, force: true });}
  }
  save("mutations.json", results);
  console.log(JSON.stringify({ mutationsKilled: results.length, propertyMutationLimits: "Compact field omissions are recovered by line metadata; the additive API contract and address metadata are verified by PDD-1 and PDD-4." }));
}

const phase = process.argv[2] || "all";
if (phase === "all") {
  for (const name of ["coverage", "c8"]) {rmSync(path.join(artifact, name), { recursive: true, force: true });}
  focused(); staticChecks(); mutations(); await suites();
} else {
  if (phase === "focused") {focused();}
  if (phase === "static") {staticChecks();}
  if (phase === "mutations") {mutations();}
  if (phase === "suites") {await suites();}
}
save("source-hashes.json", Object.fromEntries([...production, regression,
  "test/support/dispatch-po-line-destination-functions.mjs", "tools/dispatch-po-line-destinations-check.mjs",
  "test/dispatch-po-line-destinations.spec.json"].map(name => [name, createHash("sha256").update(readFileSync(name)).digest("hex")])));
console.log(JSON.stringify({ completed: phase }));
