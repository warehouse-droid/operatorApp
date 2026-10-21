import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanUnifiedDiff } from "../../test/support/scan-diff-secrets.mjs";

const out = "/evidence";
const requestedMode = process.argv[2];
const mode = requestedMode === "baseline-static" ? "regression-baseline"
  : ["regression-final", "final-static"].includes(requestedMode) ? "final" : requestedMode;
const files = ["src/dispatch-order-target-repository.js", "src/dispatch-delivery-group-repository.js",
  "public/dispatch.js", "public/dispatch.html", "public/mbt-planning.html"];
const focusedFiles = ["test/dispatch/unit/dispatch-target-line-identity.test.js",
  "test/dispatch/integration/dispatch-target-line-identity.test.js",
  "test/dispatch/frontend/dispatch-ungroup-po-warning.test.js",
  "test/dispatch/frontend/dispatch-group-pickup-card.test.js"];
const save = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + "\n");
const hashes = () => Object.fromEntries(files.map(file => [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));

function run(label, args, { env = {}, expect = true } = {}) {
  const logPath = path.join(out, label + ".log");
  const descriptor = fs.openSync(logPath, "w");
  let result;
  try {
    result = spawnSync(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", descriptor, descriptor] });
  } finally {
    fs.closeSync(descriptor);
  }
  const log = fs.readFileSync(logPath, "utf8");
  const summary = { exitCode: result.status, tests: Number(log.match(/^# tests (\d+)$/m)?.[1] || 0),
    pass: Number(log.match(/^# pass (\d+)$/m)?.[1] || 0), fail: Number(log.match(/^# fail (\d+)$/m)?.[1] || 0),
    failures: [...log.matchAll(/^not ok \d+ - (.*)$/gm)].map(match => match[1]) };
  save(label + ".json", summary);
  if (expect && result.status !== 0) {
    process.stderr.write(log.slice(-7000));
    throw new Error(label + " failed");
  }
  return summary;
}

function focused() {
  fs.rmSync(path.join(out, "coverage"), { recursive: true, force: true });
  const result = run("focused", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
    ...files.filter(file => file.endsWith(".js")).map(file => "--include=" + file),
    "--temp-directory=/tmp/po-identity-coverage", "--report-dir=/evidence/coverage", "--reporter=json", "--reporter=text",
    "node", "--test", "--test-concurrency=1", ...focusedFiles]);
  const health = run("suite-health", ["--test", "--test-concurrency=1", ...focusedFiles.toReversed()]);
  save("focused-result.json", { ...result, hashes: hashes(), health });
  console.log(JSON.stringify({ focused: result, health }));
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

function regression() {
  const suites = ["unit", "property", "adversarial", "frontend"].flatMap(folder => walk("test/dispatch/" + folder))
    .filter(file => file.endsWith(".test.js") && !focusedFiles.includes(file));
  const integration = ["test/dispatch/integration", "test/mbt/integration"].flatMap(walk)
    .filter(file => file.endsWith(".test.js") && !focusedFiles.includes(file)
      && /dispatch-order-target-repository|dispatch-delivery-group-repository/.test(fs.readFileSync(file, "utf8")));
  const selected = [...new Set([...suites, ...integration])].sort();
  const result = run(mode + "-regression", ["--test", "--test-concurrency=1", ...selected], { expect: false });
  const harness = run(mode + "-harness", ["src/dispatch-link-target-harness.js"], { expect: false });
  save(mode + "-regression-result.json", { ...result, files: selected, harness });
  console.log(JSON.stringify({ regression: result, files: selected.length, harness: harness.exitCode }));
}

function staticChecks() {
  for (const file of files.filter(file => file.endsWith(".js"))) run(mode + "-syntax-" + path.basename(file), ["--check", file]);
  const lint = spawnSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "--config", "tools/po-line-identity-20261015/eslint.config.mjs",
    "--format=json", ...files.filter(file => file.endsWith(".js")), ...(mode === "final" ? focusedFiles : [])],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, mode + "-lint.log"), lint.stdout + lint.stderr);
  const lintRows = JSON.parse(lint.stdout || "[]");
  assert.ok(lintRows.length >= 3 && lintRows.every(row => row.fatalErrorCount === 0), "Lint tooling or parsing failed");
  const messages = lintRows.flatMap(row => row.messages.map(message => ({ file: row.filePath.replace("/app/", ""),
    rule: message.ruleId, severity: message.severity, message: message.message })))
    .filter(message => !message.message.includes("File ignored"));
  const types = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, mode + "-types.log"), types.stdout + types.stderr);
  const typeMessages = (types.stdout + types.stderr).split(/\r?\n/).filter(Boolean)
    .map(line => line.replace(/\(\d+,\d+\)/g, "(line,column)"));
  assert.ok(types.status !== null && !typeMessages.some(line => /TS5058|SIGKILL|Cannot find module.*typescript/.test(line)), "Type tooling failed");
  save(mode + "-static.json", { lintExit: lint.status, messages, typesExit: types.status, typeMessages });
}

function mutations() {
  const target = files[0], retirement = files[1], client = files[2];
  const mutants = [
    ["ignore-row-priority", target, "if (rowMatch) return rowMatch;", "if (false) return rowMatch;"],
    ["ignore-line-priority", target, "return lineMatch || lines.find", "return lines.find"],
    ["use-parent-row-for-child", target, "allowRowId: !exactHeader || !parentRef", "allowRowId: true"],
    ["old-materialization-matcher", target, "findLineForItem(splitLines, item, { allowRowId: false })",
      "splitLines.find((line) => lineMatchesItem(line, item, { allowRowId: false }))"],
    ["drop-sku-fallback", target,
      'return Boolean(sku && [line.sku, line.item_name].map((value) => text(value).toLowerCase()).includes(sku));', 'return false;'],
    ["skip-po-cleanup", retirement, "WHERE allocation.status = 'active'", "WHERE allocation.status = 'cancelled'"],
    ["skip-po-warning", client, "allocations.length && !confirm(`Ungroup", "false && !confirm(`Ungroup"],
    ["ignore-po-detection-error", client, "if (!response.ok) throw new Error(await dispatchErrorMessage(response));\n      const allocations",
      "if (false) throw new Error(await dispatchErrorMessage(response));\n      const allocations"],
    ["bypass-warning-on-click", client, "await ungroupOrderWithPoCheck(actionOrderId);", "ungroupOrder(actionOrderId);"],
    ["invent-placeholder-yard", client, 'type === "SO" && order.catalogHydrated !== false', 'type === "SO"'],
    ["omit-placeholder-marker", client,
      'type: canonicalDispatchOrderType(fallbackType === "CO" ? "" : fallbackType, childId),\n        catalogHydrated: false',
      'type: canonicalDispatchOrderType(fallbackType === "CO" ? "" : fallbackType, childId)'],
    ["drop-legacy-source-default", client, '? ["3445"]\n        : [];', '? []\n        : [];'],
    ["zero-pallet-placeholder-sum", client,
      'if (childOrderDetails.some((child) => child.catalogHydrated === false && !child.items?.length)) {',
      'if (false) {']
  ];
  fs.mkdirSync("/tmp/po-identity-mutants", { recursive: true });
  const results = [];
  for (const [name, file, old, replacement] of mutants) {
    const original = fs.readFileSync(file, "utf8");
    assert.equal(original.split(old).length - 1, 1, "Mutation must have one target: " + name);
    const mutant = "/tmp/po-identity-mutants/" + name + ".js";
    fs.writeFileSync(mutant, original.replace(old, replacement));
    const env = { PO_IDENTITY_MUTANT_TARGET: "/app/" + file, PO_IDENTITY_MUTANT_SOURCE: mutant,
      ...(file === target ? { PO_IDENTITY_SOURCE: mutant } : {}),
      ...(file === client ? { PO_IDENTITY_BROWSER_SOURCE: mutant } : {}) };
    const selectedTests = file === target ? focusedFiles.slice(0, 2)
      : file === retirement ? [focusedFiles[1]]
      : ["skip-po-warning", "ignore-po-detection-error", "bypass-warning-on-click"].includes(name)
        ? [focusedFiles[2]] : [focusedFiles[3]];
    const result = run("mutant-" + name, ["--experimental-loader", "./tools/po-line-identity-20261015/mutation-loader.mjs",
      "--test", "--test-concurrency=1", ...selectedTests], { env, expect: false });
    assert.ok(result.exitCode !== 0 && result.failures.length, "Surviving mutation: " + name);
    let propertyOnly;
    if (["ignore-row-priority", "ignore-line-priority", "invent-placeholder-yard"].includes(name)) {
      propertyOnly = run("property-mutant-" + name, ["--test",
        name === "invent-placeholder-yard" ? "--test-name-pattern=property:" : "--test-name-pattern=repeated item resolution is independent|exact parent row selection survives",
        name === "invent-placeholder-yard" ? focusedFiles[3] : focusedFiles[0]], { env, expect: false });
      assert.ok(propertyOnly.exitCode !== 0 && propertyOnly.failures.length,
        "Identity properties failed to detect mutation: " + name);
    }
    results.push({ name, killed: true, testFiles: selectedTests, failures: result.failures, ...(propertyOnly ? { propertyOnly } : {}) });
  }
  save("mutations.json", results);
  console.log(JSON.stringify({ killed: results.length, total: mutants.length }));
}

function summary() {
  const load = name => JSON.parse(fs.readFileSync(path.join(out, name), "utf8"));
  const baseline = load("regression-baseline-regression-result.json");
  const current = load("final-regression-result.json");
  assert.deepEqual(current.failures.slice().sort(), baseline.failures.slice().sort(), "New regression failures");
  assert.equal(current.harness.exitCode, baseline.harness.exitCode, "New harness failure");
  assert.equal(fs.readFileSync(path.join(out, "final-harness.log"), "utf8"),
    fs.readFileSync(path.join(out, "regression-baseline-harness.log"), "utf8"), "Harness failure changed");
  const prior = load("regression-baseline-static.json"), latest = load("final-static.json");
  const unmatched = (currentMessages, baselineMessages) => {
    const remaining = new Map();
    for (const message of baselineMessages) {
      const key = JSON.stringify(message);
      remaining.set(key, (remaining.get(key) || 0) + 1);
    }
    return currentMessages.filter(message => {
      const key = JSON.stringify(message);
      const available = remaining.get(key) || 0;
      if (!available) return true;
      remaining.set(key, available - 1);
      return false;
    });
  };
  const newLint = unmatched(latest.messages, prior.messages);
  const newTypes = unmatched(latest.typeMessages, prior.typeMessages);
  assert.deepEqual(newLint, [], "New lint diagnostics");
  assert.deepEqual(newTypes, [], "New type diagnostics");
  const result = load("focused-result.json");
  assert.deepEqual(result.hashes, hashes());
  const mutations = load("mutations.json");
  assert.ok(mutations.length === 13 && mutations.every(row => row.killed));
  assert.equal(mutations.filter(row => row.propertyOnly?.failures?.length).length, 3);
  assert.equal(load("browser.json").passed, true);
  assert.equal(load("browser.json").sourceHash, hashes()[files[2]]);
  assert.equal(load("pickup-card-fixed.json").corrected, true);
  assert.equal(load("pickup-card-fixed.json").sourceHash, hashes()[files[2]]);
  assert.ok(load("changed-coverage.json").every(row => row.missing.length === 0));
  const secrets = scanUnifiedDiff(fs.readFileSync(path.join(out, "production.patch"), "utf8"));
  assert.deepEqual(secrets, [], "Secret scan failed");
  const toolchain = Object.fromEntries(["c8", "typescript", "eslint", "fast-check", "playwright"].map(name =>
    [name, JSON.parse(fs.readFileSync(path.join("node_modules", name, "package.json"), "utf8")).version]));
  save("final.json", { exitCode: 0, failures: [], completeGauntlet: true,
    sourceHash: result.hashes[files[0]], hashes: result.hashes, focused: result, regression: current,
    baselineFailures: baseline.failures, mutationsKilled: mutations.length, newLint, newTypes,
    secrets, toolchain, newDependencies: [], node: process.version });
  console.log(JSON.stringify({ pass: result.pass, regressionPass: current.pass, preExistingFailures: baseline.failures.length,
    mutations: mutations.length, newLint: 0, newTypes: 0 }));
}

if (requestedMode === "baseline-static") staticChecks();
else if (requestedMode === "final-static") staticChecks();
else if (requestedMode === "regression-final") {
  regression();
  staticChecks();
  focused();
}
else if (mode === "focused") focused();
else if (mode === "final" || mode === "regression-baseline") {
  regression();
  staticChecks();
  if (mode === "final") focused();
} else if (mode === "mutations") {
  mutations();
} else if (mode === "summary") {
  summary();
} else {
  throw new Error("Unknown check mode: " + mode);
}
